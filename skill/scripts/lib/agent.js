// Agent adapter of the run loop: spawns the user's own agent CLI for one roadmap step. The agent's output is untrusted
// data; the runner decides every status from facts it observed itself (exit code, signal, timeout) and from a status
// block parsed with parseStatus (which needs the expected step id). The process is started from an argv array without a
// shell, with a sanitized environment, no stdin and in its own process group (killed as a group after exit and on
// timeout, shared machinery of runverify.js). Output lives in a bounded redacted ring buffer; nothing is stored or
// returned unredacted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnCaptured, cleanTail } from './runverify.js';
import { parseStatus } from './runstatus.js';
import { isStepId } from './runplan.js';
import { writeGenerated } from './aidir.js';
import { deniedEnvName, envBehaviorAllowed, validEnvName, passEnvAllowed, hasControl } from './runconfig.js';
import { redact } from './redact.js';
import { mdText } from './mdtext.js';

export const OUTPUT_TAIL_BYTES = 200 * 1024;
export const LOG_MAX_BYTES = 200 * 1024;
const MAX_LINE_BYTES = 1024 * 1024; // a JSON result line above this is ignored (usage null, no envelope status)
const MAX_BRIEF_BYTES = 256 * 1024;
const MAX_ARG_BYTES = 4096;
const MAX_ENV_VALUE = 8192;
const MAX_BASE_ENV_VALUE = 32 * 1024; // PATH can be long; it is copied from the user's own environment
const MAX_TURNS = 200;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const BASE_ENV = ['PATH', 'HOME', 'LANG'];
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/**
 * Default argv templates per agent kind. THESE ARE UNVERIFIED: they were written from memory without access to the
 * CLIs, and agent CLI flags change between releases (check the current CLI help). They are data, not logic: the user
 * overrides the whole argv in .ai/run.config.json (agent.command), and `run` prints the effective argv before starting.
 * Placeholders (substituted by runAgent AFTER the config is validated, as plain data, never through a shell):
 *   {prompt}   a short fixed prompt that points at the brief file by its project-relative path
 *   {brief}    the project-relative path of the brief file (.ai/runs/<run>/brief-<n>.md)
 *   {maxTurns} the numeric turn limit of the step
 *   {step}     the step id
 * No permission profile is claimed: flags for one cannot be verified offline. A team demands one through
 * agent.requireArgs (every listed string must be an element of the argv).
 */
export const AGENT_DEFAULTS = Object.freeze({
  claude: Object.freeze({
    argv: Object.freeze(['claude', '-p', '{prompt}', '--output-format', 'json', '--max-turns', '{maxTurns}']),
    unverified: true,
    docs: 'check the current CLI help',
  }),
  codex: Object.freeze({
    argv: Object.freeze(['codex', 'exec', '{prompt}']),
    unverified: true,
    docs: 'check the current CLI help',
  }),
});

export const NO_RESTRICTIONS_WARNING = 'no permission restrictions are configured for the agent';

class AgentRefusal extends Error {
  constructor(message) {
    super(`agent: ${message}`);
    this.name = 'AgentRefusal';
  }
}
const refuse = (m) => new AgentRefusal(m);

/** A fresh per-iteration secret: the brief asks for it in the status block, project files predate it. */
export const newNonce = () => crypto.randomBytes(8).toString('hex');
const isNonce = (n) => typeof n === 'string' && /^[0-9a-f]{16}$/.test(n);

/**
 * The agent argv template that will run: the configured command, or the kind's default template when the command is just
 * the bare kind name. Returns { kind, argv (still with placeholders), usesDefault, unverified, docs }.
 */
export function effectiveAgent(config) {
  const a = config?.agent;
  if (a === null || typeof a !== 'object' || typeof a.kind !== 'string' || !Array.isArray(a.command) || a.command.length === 0) throw refuse('the configuration has no agent command');
  const def = Object.hasOwn(AGENT_DEFAULTS, a.kind) ? AGENT_DEFAULTS[a.kind] : null;
  const usesDefault = def !== null && a.command.length === 1 && a.command[0] === a.kind;
  return {
    kind: a.kind,
    argv: usesDefault ? [...def.argv] : [...a.command],
    usesDefault,
    unverified: usesDefault,
    docs: usesDefault ? def.docs : null,
  };
}

/** One printable terminal line for the effective argv (placeholders as written, redacted, control characters shown as ?). */
export function describeAgentArgv(config) {
  const { argv } = effectiveAgent(config);
  const show = (a) => {
    let t = '';
    for (const ch of redact(String(a)).text.slice(0, 200)) {
      const c = ch.charCodeAt(0);
      t += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? '?' : ch;
    }
    return t === '' || /[\s"'\\]/.test(t) ? JSON.stringify(t) : t;
  };
  return argv.map(show).join(' ');
}

/** Warnings `run` prints before starting: unverified default flags, no permission restrictions configured. */
export function agentWarnings(config) {
  const eff = effectiveAgent(config);
  const out = [];
  if (eff.unverified) out.push(`the default ${eff.kind} command line is unverified (${eff.docs}); override agent.command in .ai/run.config.json if it fails`);
  if ((config.agent.requireArgs ?? []).length === 0) out.push(NO_RESTRICTIONS_WARNING);
  return out;
}

function checkRequireArgs(config, argv) {
  const req = config.agent.requireArgs ?? [];
  if (!Array.isArray(req)) throw refuse('agent.requireArgs must be an array');
  for (const r of req) {
    if (typeof r !== 'string' || r === '') throw refuse('agent.requireArgs must hold non-empty strings');
    if (!argv.includes(r)) throw refuse(`the agent command does not contain the required argument ${JSON.stringify(mdText(redact(r).text).slice(0, 60))}; refusing to run`);
  }
}

/** The agent process environment: PATH, HOME, LANG + passEnv names from the user's own environment + config env. */
export function buildAgentEnv(config, source = process.env) {
  const env = {};
  const set = (k, v, what, max = MAX_ENV_VALUE) => {
    if (typeof v !== 'string' || v.length > max || hasControl(v)) throw refuse(`${what} ${k} has a value that is too long or contains control characters or newlines`);
    env[k] = v;
  };
  for (const k of BASE_ENV) if (typeof source[k] === 'string' && source[k] !== '') set(k, source[k], 'environment variable', MAX_BASE_ENV_VALUE);
  const pass = config.agent.passEnv ?? [];
  if (!Array.isArray(pass)) throw refuse('agent.passEnv must be an array');
  for (const k of pass) {
    if (!passEnvAllowed(k)) throw refuse('agent.passEnv holds a name that is not allowed');
    if (typeof source[k] === 'string' && source[k] !== '') set(k, source[k], 'passEnv variable');
  }
  const own = config.agent.env ?? {};
  if (own === null || typeof own !== 'object' || Array.isArray(own)) throw refuse('agent.env must be an object');
  for (const k of Object.keys(own)) {
    if (!validEnvName(k) || deniedEnvName(k) || !envBehaviorAllowed(k)) throw refuse('agent.env holds a name that is not allowed');
    if (Object.hasOwn(env, k) || pass.includes(k)) throw refuse(`agent.env.${k} is also passed through passEnv or is reserved`);
    set(k, own[k], 'agent.env');
  }
  return env;
}

const isNonBlank = (seg) => {
  for (let i = 0; i < seg.length; i++) if (seg[i] !== 32 && seg[i] !== 9 && seg[i] !== 13) return true;
  return false;
};

/** Keeps only the LAST non-empty stdout line, in bounded memory: a line above MAX_LINE_BYTES counts as "too large". */
class LastLine {
  constructor() {
    this.parts = [];
    this.len = 0;
    this.over = false;
    this.nonBlank = false;
    this.last = null; // Buffer of the last non-empty line, or the string 'big' when that line was too large
  }

  feed(chunk) {
    let pos = 0;
    while (pos < chunk.length) {
      const nl = chunk.indexOf(10, pos);
      const end = nl === -1 ? chunk.length : nl;
      if (nl !== -1 && this.parts.length === 0 && !this.over && !this.nonBlank) {
        // A whole line inside this chunk: remember a view of it, no copy (floods of tiny lines stay cheap).
        const seg = chunk.subarray(pos, end);
        if (isNonBlank(seg)) this.last = seg.length > MAX_LINE_BYTES ? 'big' : seg;
      } else {
        this.#append(chunk.subarray(pos, end));
        if (nl !== -1) this.#endLine();
      }
      if (nl === -1) break;
      pos = nl + 1;
    }
  }

  #append(seg) {
    if (seg.length === 0) return;
    if (!this.nonBlank && isNonBlank(seg)) this.nonBlank = true;
    if (this.over) return;
    if (this.len + seg.length > MAX_LINE_BYTES) {
      this.over = true;
      this.parts = [];
      return;
    }
    this.parts.push(Buffer.from(seg));
    this.len += seg.length;
  }

  #endLine() {
    if (this.nonBlank) this.last = this.over ? 'big' : Buffer.concat(this.parts);
    this.parts = [];
    this.len = 0;
    this.over = false;
    this.nonBlank = false;
  }

  /** The last non-empty line (call once, at the end of the stream). */
  finish() {
    this.#endLine();
    return this.last;
  }
}

/** Parsed JSON object of the last line, or null (not JSON, too large, not an object). */
function lastJson(line) {
  if (!Buffer.isBuffer(line)) return null;
  const text = line.toString('utf8').trim();
  if (!text.startsWith('{')) return null;
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * { inputTokens, outputTokens, totalTokens } from `usage.input_tokens` / `usage.output_tokens` of a JSON object, else
 * null. Only the documented result envelope counts: the object must have `type: "result"` (plain text output that merely
 * contains a JSON line, say a model echoing one, is never trusted).
 */
export function extractUsage(obj) {
  if (obj === null || typeof obj !== 'object' || obj.type !== 'result') return null;
  const u = obj !== null && typeof obj === 'object' && Object.hasOwn(obj, 'usage') ? obj.usage : null;
  if (u === null || typeof u !== 'object' || Array.isArray(u)) return null;
  if (!Object.hasOwn(u, 'input_tokens') || !Object.hasOwn(u, 'output_tokens')) return null;
  const { input_tokens: i, output_tokens: o } = u;
  if (!isCount(i) || !isCount(o) || !Number.isSafeInteger(i + o)) return null;
  return { inputTokens: i, outputTokens: o, totalTokens: i + o };
}

/**
 * Per-iteration token floor: maxTotalTokens / (maxIterations * 10), at least 1. A reported total below it (a lying or
 * broken agent) is raised to it by runAgent, so usage can never be used to stall the token budget. The result also
 * carries `usageFloor` for the caller's per-iteration estimate when `usage` is null.
 */
export function usageFloor(config) {
  const b = config?.budgets ?? {};
  const t = Number.isSafeInteger(b.maxTotalTokens) ? b.maxTotalTokens : 400000;
  const it = Number.isSafeInteger(b.maxIterations) && b.maxIterations > 0 ? b.maxIterations : 10;
  return Math.max(1, Math.floor(t / (it * 10)));
}

/** Last `max` bytes of a string (a split UTF-8 sequence at the cut is dropped). */
function lastBytes(text, max) {
  const b = Buffer.from(text, 'utf8');
  if (b.length <= max) return text;
  let i = b.length - max;
  while (i < b.length && (b[i] & 0xc0) === 0x80) i++;
  return b.subarray(i).toString('utf8');
}

const safeId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 64 && [...s].every((c) => ID_CHARS.includes(c));

function substitute(template, values) {
  return template.map((el) => {
    let out = el;
    for (const [k, v] of Object.entries(values)) if (out.includes(k)) out = out.split(k).join(v);
    if (Buffer.byteLength(out) > MAX_ARG_BYTES) throw refuse('an argument is too long after substitution');
    return out;
  });
}

const exists = (abs) => {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
};

function plainWriteError(err) {
  const m = String(err?.message ?? '');
  if (m.startsWith('refusing') || m.startsWith('no .ai folder')) return refuse(`cannot write under .ai/runs: ${mdText(m).slice(0, 200)}`);
  return refuse(`cannot write under .ai/runs (${err?.code ?? 'error'})`);
}

/**
 * Runs the agent for one step.
 *   brief:     the brief text (written to .ai/runs/<run>/brief-<n>.md through the guarded writer, redacted)
 *   step:      the step object (or id string); only the id is used
 *   turns:     numeric turn limit for {maxTurns} (default config.budgets.maxTurnsPerStep, at most 200)
 *   timeoutMs: hard wall-clock limit (default 30 minutes, at most 24 hours)
 *   now:       Date or ms, used for the run folder name when `runId` is not given
 *   nonce:     this iteration's secret (newNonce(); the brief must contain it, buildStepBrief puts it in the status example);
 *              a status block counts only when it carries it. Status is read from STDOUT only (never stderr).
 *   runId:     folder name under .ai/runs (letters, digits, "_" and "-"); n: first brief/log number (default 1)
 * Returns { status, usage, exitCode, signal, timedOut, outputTail, logPath, logError, briefPath }:
 *   status    ParsedStatus ({ ok, status } or { ok:false, reason }); a timeout, a signal, a non-zero exit or a failed start
 *             is never ok, whatever the agent printed (only runner-observed facts decide that)
 *   usage     { inputTokens, outputTokens, totalTokens } or null; trusted only from a `type: "result"` stdout line and its
 *             total is raised to usageFloor(config). null means: use `usageFloor` as the per-iteration estimate.
 *   outputTail last 200 KB of stdout+stderr, cleaned and redacted
 * Throws a plain AgentRefusal (no stack, no absolute path) when the request or the configuration is not acceptable.
 */
export async function runAgent(root, config, { brief, step, turns, timeoutMs, now, runId, n, nonce } = {}) {
  const stepId = typeof step === 'string' ? step : step?.id;
  if (typeof stepId !== 'string' || stepId.length === 0 || !isStepId(stepId) || stepId.startsWith('-')) throw refuse('the step id is not acceptable');
  if (!isNonce(nonce)) throw refuse('a nonce (newNonce()) is required');
  if (typeof brief !== 'string' || brief.length === 0 || Buffer.byteLength(brief) > MAX_BRIEF_BYTES) throw refuse('the brief must be non-empty text of at most 256 KB');
  if (!brief.includes(nonce)) throw refuse('the brief does not contain the nonce');
  const maxTurns = turns ?? config?.budgets?.maxTurnsPerStep ?? 20;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_TURNS) throw refuse(`turns must be an integer from 1 to ${MAX_TURNS}`);
  const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TIMEOUT_MS) throw refuse('timeoutMs must be a positive integer of at most 24 hours');
  let date = new Date(now ?? Date.now());
  if (Number.isNaN(date.getTime())) date = new Date();
  const id = runId ?? date.toISOString().replace(/[-:.]/g, '');
  if (!safeId(id)) throw refuse('runId may only contain letters, digits, "_" and "-"');
  let num = n ?? 1;
  if (!Number.isSafeInteger(num) || num < 1 || num > 100000) throw refuse('n must be a positive integer');

  const eff = effectiveAgent(config);
  for (const el of eff.argv) if (typeof el !== 'string' || el === '' || hasControl(el) || Buffer.byteLength(el) > MAX_ARG_BYTES) throw refuse('the agent command holds an argument that is not acceptable');
  checkRequireArgs(config, eff.argv);
  const env = buildAgentEnv(config);

  // Brief and log numbers: never overwrite an earlier iteration's files.
  const dir = path.join(root, '.ai', 'runs', id);
  while (exists(path.join(dir, `brief-${num}.md`)) || exists(path.join(dir, `agent-${num}.log`))) {
    num++;
    if (num > 100000) throw refuse('too many runs in one folder');
  }
  const briefRel = `.ai/runs/${id}/brief-${num}.md`;
  const logRel = `.ai/runs/${id}/agent-${num}.log`;
  try {
    writeGenerated(root, { [`runs/${id}/brief-${num}.md`]: brief });
  } catch (err) {
    throw plainWriteError(err);
  }
  const prompt = `Read ${briefRel} and follow it exactly; end your final message with the status block.`;
  const argv = substitute(eff.argv, { '{prompt}': prompt, '{brief}': briefRel, '{maxTurns}': String(maxTurns), '{step}': stepId });

  const lastLine = new LastLine();
  const r = await spawnCaptured(root, argv, { env, timeoutMs: limit, tailBytes: OUTPUT_TAIL_BYTES, onStdout: (c) => lastLine.feed(c) });
  const outputTail = lastBytes(r.text, OUTPUT_TAIL_BYTES);
  const json = lastJson(lastLine.finish());
  const floor = usageFloor(config);
  let usage = extractUsage(json);
  if (usage !== null && usage.totalTokens < floor) usage = { ...usage, totalTokens: floor };

  // Status: what the runner observed first; then the final text (raw output, then the JSON envelope's result string).
  let status;
  let envelopeText = null;
  if (!r.started) status = { ok: false, reason: 'the agent could not be started' };
  else if (r.timedOut) status = { ok: false, reason: 'the agent timed out and was killed' };
  else if (r.signal) status = { ok: false, reason: `the agent was ended by signal ${r.signal}` };
  else if (r.exitCode !== 0) status = { ok: false, reason: `the agent exited with code ${r.exitCode}` };
  else {
    status = parseStatus(r.stdoutText, stepId, nonce);
    if (!status.ok && typeof json?.result === 'string') {
      envelopeText = cleanTail(json.result.slice(-OUTPUT_TAIL_BYTES));
      const viaEnvelope = parseStatus(envelopeText, stepId, nonce);
      if (viaEnvelope.ok) status = viaEnvelope;
    }
  }

  let logPath = null;
  let logError = null;
  const head = [
    `step: ${mdText(stepId)}`,
    `exit: ${r.started ? (r.exitCode ?? 'none') : 'not started'}${r.signal ? ` signal ${r.signal}` : ''}${r.timedOut ? ' (timed out)' : ''}`,
    `status: ${status.ok ? status.status.status : `invalid (${status.reason})`}`,
    '--- output (last part, redacted) ---',
  ].join('\n');
  const tailPart = lastBytes(outputTail, Math.floor(LOG_MAX_BYTES * 0.75));
  let body = `${head}\n${tailPart}\n`;
  if (envelopeText !== null) body += `--- result field of the JSON output (redacted) ---\n${lastBytes(envelopeText, Math.floor(LOG_MAX_BYTES * 0.2))}\n`;
  try {
    writeGenerated(root, { [`runs/${id}/agent-${num}.log`]: lastBytes(body, LOG_MAX_BYTES) });
    logPath = logRel;
  } catch (err) {
    logError = plainWriteError(err).message;
  }
  return { status, usage, usageFloor: floor, exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, outputTail, logPath, logError, briefPath: briefRel };
}
