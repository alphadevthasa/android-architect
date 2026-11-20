// Runs the verification commands of run.config.json. The commands are PR-controlled input: each one is spawned from an
// argv array without a shell, with a minimal environment, no stdin, in its own process group (killed as a group on
// timeout), and its output is kept only as a bounded redacted tail. Verification executes the project's Gradle build
// code; confirmFirstUse (rungit.js) is the consent gate for that.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { redact } from './redact.js';
import { stripUnsafe } from './mdtext.js';

const TAIL_BYTES = 20 * 1024;
const KILL_GRACE_MS = 5000;
const CLOSE_GRACE_MS = 500;
const ENV_NAMES = ['PATH', 'HOME', 'LANG', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME'];
const SIGNATURE_LINES = 5;
const SIGNATURE_LINE_MAX = 500;

/** The only environment a verification command gets (Gradle needs these); everything else is dropped. */
function childEnv() {
  const env = {};
  for (const k of ENV_NAMES) if (typeof process.env[k] === 'string' && process.env[k] !== '') env[k] = process.env[k];
  env.CI = '1';
  return env;
}

// A tail that starts inside a PEM block has lost its BEGIN line, so redact() cannot see the block: drop the leading
// base64-looking lines (mixed case and digits, as key bodies are) and the END line after them; a run of 64 or more
// such lines is dropped even without an END line. Plain repeated-character output is not mistaken for a key body.
const B64_LINE = /^[A-Za-z0-9+/]{40,}={0,2}$/;
const PEM_END = /^-----END [A-Z ]{3,40}-----$/;
const looksBase64 = (l) => B64_LINE.test(l) && /[A-Z]/.test(l) && /[a-z]/.test(l) && /[0-9]/.test(l);

function dropOpenBlock(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && looksBase64(lines[i].trim())) i++;
  if (i < lines.length && PEM_END.test(lines[i].trim())) i++;
  else if (i < 64) i = 0;
  return lines.slice(i).join('\n');
}

/** Keeps the last TAIL_BYTES bytes of everything fed to it; memory never exceeds TAIL_BYTES plus one chunk (<= 64 KB). */
class Tail {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.truncated = false;
  }

  push(chunk) {
    const all = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    if (all.length > TAIL_BYTES) {
      this.truncated = true;
      this.buf = Buffer.from(all.subarray(all.length - TAIL_BYTES));
    } else this.buf = Buffer.from(all);
  }

  /** Text of the tail with the cut start dropped (a half line or half token could hold the end of a secret). */
  text() {
    let b = this.buf;
    let s;
    if (this.truncated) {
      let i = 0;
      while (i < 4 && i < b.length && (b[i] & 0xc0) === 0x80) i++; // split UTF-8 sequence
      b = b.subarray(i);
      s = b.toString('utf8');
      const nl = s.indexOf('\n');
      s = nl >= 0 ? s.slice(nl + 1) : s.slice(128);
      s = dropOpenBlock(s);
    } else s = b.toString('utf8');
    return s;
  }
}

/** Escape sequences, control and bidi characters removed (newline and tab kept), then secrets redacted. */
function cleanTail(raw) {
  const noEsc = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b[\]P^_][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '');
  const noCtl = stripUnsafe(noEsc).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  return redact(noCtl).text;
}

// Normalization for the error signature. Every pattern is linear on a line capped at SIGNATURE_LINE_MAX characters.
const NORMALIZERS = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>'],
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<uuid>'],
  [/(?<![\w.])(?:[A-Za-z]:)?[\\/](?:[^\s\\/:'"()<>[\],;=]+[\\/])+/g, '<dir>/'],
  [/\b0[xX][0-9a-fA-F]+\b/g, '<hex>'],
  [/\b[0-9a-fA-F]{8,}\b/g, '<hex>'],
  [/\d+/g, 'N'],
];

function normalizeLine(line) {
  let out = line.slice(0, SIGNATURE_LINE_MAX);
  for (const [re, to] of NORMALIZERS) out = out.replace(re, to);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Error signature of a failed command (spec 5.15 "normalized error hash"): the first 5 lines containing error, FAILED or
 * Exception (case-insensitive), absolute paths, numbers, hex ids, timestamps and temp dirs normalized, joined and
 * SHA-256'd (first 16 hex chars). A failure without such a line uses its last non-empty line and how it ended.
 */
function signatureOf(tail, ended) {
  const lines = tail.split('\n');
  const hits = [];
  for (const line of lines) {
    const low = line.toLowerCase();
    if (low.includes('error') || low.includes('failed') || low.includes('exception')) {
      hits.push(normalizeLine(line));
      if (hits.length === SIGNATURE_LINES) break;
    }
  }
  if (hits.length === 0) {
    const last = [...lines].reverse().find((l) => l.trim() !== '') ?? '';
    hits.push(`[${ended}]`, normalizeLine(last));
  }
  return crypto.createHash('sha256').update(hits.join('\n')).digest('hex').slice(0, 16);
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pid, ms) {
  const end = Date.now() + ms;
  while (groupAlive(pid) && Date.now() < end) await sleep(25);
}

/** SIGTERM to the whole process group, SIGKILL after the grace period; resolves when the group is gone. Idempotent. */
async function terminateGroup(pid) {
  if (!groupAlive(pid)) return;
  killGroup(pid, 'SIGTERM');
  await waitGone(pid, KILL_GRACE_MS);
  if (groupAlive(pid)) {
    killGroup(pid, 'SIGKILL');
    await waitGone(pid, 1000);
  }
}

// Live process groups, killed when the runner itself exits or is interrupted. One set of handlers for the whole process.
const live = new Set();
let cleanupInstalled = false;

/** Kills every live verification process group now (default SIGKILL). Safe to call repeatedly. */
export function killLiveGroups(signal = 'SIGKILL') {
  for (const pid of [...live]) killGroup(pid, signal);
}

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('exit', () => killLiveGroups('SIGKILL'));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      killLiveGroups('SIGKILL');
      process.off(sig, handler);
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig); // keep the default exit behavior
    };
    process.on(sig, handler);
  }
}

function runOne(root, argv, timeoutMs) {
  return new Promise((resolve) => {
    const tail = new Tail();
    let timedOut = false;
    let settled = false;
    let child;
    let termTimer = null;
    const finish = (exitCode, signal, note) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      if (child?.pid) live.delete(child.pid);
      const shown = note ? `${note}\n` : '';
      const text = cleanTail(shown + tail.text());
      const ended = timedOut ? 'timeout' : signal ? `signal ${signal}` : `exit ${exitCode}`;
      resolve({
        argv: argv.map((a) => redact(String(a)).text),
        exitCode,
        signal: signal ?? null,
        timedOut,
        tail: text.slice(-TAIL_BYTES),
        signature: exitCode === 0 && !timedOut ? '' : signatureOf(text, ended),
      });
    };
    installCleanup();
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: root, shell: false, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch {
      finish(null, null, 'the command could not be started');
      return;
    }
    child.on('error', () => finish(null, null, 'the command could not be started'));
    if (!child.pid) return;
    live.add(child.pid);
    child.stdout.on('data', (c) => tail.push(c));
    child.stderr.on('data', (c) => tail.push(c));
    child.on('exit', async (code, signal) => {
      // Whatever the leader started (a backgrounded grandchild) dies with it: the whole group, after every exit.
      await terminateGroup(child.pid);
      await Promise.race([new Promise((r) => child.once('close', r)), sleep(CLOSE_GRACE_MS)]);
      child.stdout.destroy();
      child.stderr.destroy();
      finish(code, signal);
    });
    termTimer = setTimeout(() => {
      timedOut = true;
      terminateGroup(child.pid);
    }, timeoutMs);
  });
}

/**
 * Runs config.verification.commands one after the other in `root`; the first failure stops the list.
 * Returns { ok, results: [{ argv, exitCode, signal, timedOut, tail, signature }] }. `timeoutMs` is per command
 * (default config.verification.timeoutSeconds). An empty command list is ok:false with a `reason` (verifying nothing
 * is never a pass). After every command, normal or not, its whole process group is terminated.
 */
export async function runVerification(root, config, { timeoutMs } = {}) {
  const limit = timeoutMs ?? (config?.verification?.timeoutSeconds ?? 1800) * 1000;
  const results = [];
  if ((config?.verification?.commands ?? []).length === 0) return { ok: false, results, reason: 'no verification commands are configured' };
  for (const argv of config?.verification?.commands ?? []) {
    const r = await runOne(root, argv, limit);
    results.push(r);
    if (r.exitCode !== 0 || r.timedOut) return { ok: false, results };
  }
  return { ok: true, results };
}
