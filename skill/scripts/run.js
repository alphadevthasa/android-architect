#!/usr/bin/env node
// The autonomous run loop, from a terminal. Usage and flags: see USAGE below (and `run --help`).
// This is the user-facing glue around lib/runloop.js: strict argv parsing, the first-use consent (an explicit "yes" typed
// at an interactive terminal; there is deliberately no --yes), redacted and bounded output, and stable exit codes.
// Rules this file keeps: option values come only from argv (never from the environment, config or files), no signal
// listeners (runLoop owns them, so its second-signal exit keeps working), no process.exit (the exit code is returned),
// no raw agent output is ever printed, and nothing here touches the network.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isGradleProject } from './lib/init.js';
import { runLoop as defaultRunLoop } from './lib/runloop.js';
import { loadRunConfig } from './lib/runconfig.js';
import { loadPlan, nextRunnable } from './lib/runplan.js';
import { effectiveAgent, agentWarnings } from './lib/agent.js';
import { confirmFirstUse, plainText } from './lib/rungit.js';
import { sanitizeReport } from './lib/runreport.js';

export const BOOLEAN_FLAGS = Object.freeze(['json', 'dry-run', 'help']);
export const VALUE_FLAGS = Object.freeze(['root', 'approve-build-changes']);
const MAX_APPROVALS = 20;
const HASH_RE = /^[0-9a-f]{64}$/;

/** Exit codes. 0 is reserved for a finished run (outcome `done`) and for --help and --dry-run. */
export const EXIT = Object.freeze({ OK: 0, REFUSED: 2, NEEDS_HUMAN: 3, STOPPED: 4, TAMPERED: 5, LIMIT: 6, FAILED: 7 });
/** Outcome of runLoop -> exit code. An outcome missing from this table exits with EXIT.FAILED. */
export const OUTCOME_EXIT = Object.freeze({
  done: EXIT.OK,
  refused: EXIT.REFUSED,
  'needs-human': EXIT.NEEDS_HUMAN,
  stopped: EXIT.STOPPED,
  interrupted: EXIT.STOPPED,
  tampered: EXIT.TAMPERED,
  budget: EXIT.LIMIT,
  'no-progress': EXIT.LIMIT,
  'repeated-error': EXIT.LIMIT,
  'verification-failed': EXIT.LIMIT,
  failed: EXIT.FAILED,
});

export const USAGE = [
  'usage: android-architect run [--root <dir>] [--json] [--dry-run] [--approve-build-changes <hash>]... | --help',
  '  --root <dir>                      project root (default: the current directory)',
  '  --json                            print the result as one JSON object (progress goes to stderr)',
  '  --dry-run                         validate the config and print the plan, consent text and gates; run and write nothing',
  '  --approve-build-changes <hash>    repeatable (at most 20), each exactly 64 hex characters, taken from this command line only.',
  '                                    Use it after a run stopped with "build files changed": first review `git diff` and `git status`',
  '                                    of exactly the listed files; the hash binds to their exact content.',
  '  --help                            this text',
  'exit codes: 0 done, 2 refused or usage error, 3 needs-human, 4 stopped or interrupted, 5 tampered,',
  '            6 budget / no-progress / repeated-error / verification-failed, 7 failed or unknown',
].join('\n');

const HELP = `${USAGE}\n\nThe first run asks for confirmation: type "yes" at an interactive terminal. There is no --yes option and a non-interactive stdin never confirms.\nBudgets, the agent and the verification commands come from .ai/run.config.json only. Nothing is pushed, merged or published.`;

/** Strict argv parser. Returns { root, json, dryRun, help, approved } or { error }. */
export function parseArgs(argv) {
  const o = { root: null, json: false, dryRun: false, help: false, approved: [] };
  const seen = new Set();
  const once = (name) => {
    if (seen.has(name)) return `--${name} was given more than once`;
    seen.add(name);
    return null;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') return { error: 'invalid argument' };
    if (a === '-h') {
      o.help = true;
      continue;
    }
    if (!a.startsWith('--')) return { error: a.startsWith('-') ? `unknown option ${plainText(a, 40)}` : `unexpected argument ${plainText(a, 40)}` };
    if (a === '--yes' || a.startsWith('--yes=')) return { error: 'there is no --yes option: the first-use confirmation needs an explicit "yes" typed at an interactive terminal and cannot be scripted away' };
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) {
      const dup = once(name);
      if (dup) return { error: dup };
      if (name === 'json') o.json = true;
      else if (name === 'dry-run') o.dryRun = true;
      else o.help = true;
    } else if (VALUE_FLAGS.includes(name)) {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v === '' || v.startsWith('-')) return { error: `--${name} needs a value` };
      i++;
      if (name === 'root') {
        const dup = once(name);
        if (dup) return { error: dup };
        o.root = v;
      } else {
        const h = v.toLowerCase();
        if (!HASH_RE.test(h)) return { error: '--approve-build-changes needs exactly 64 hex characters (the hash printed by the run that stopped)' };
        if (o.approved.includes(h)) return { error: `duplicate --approve-build-changes hash ${h.slice(0, 12)}...` };
        if (o.approved.length >= MAX_APPROVALS) return { error: `at most ${MAX_APPROVALS} --approve-build-changes hashes are accepted` };
        o.approved.push(h);
      }
    } else return { error: `unknown option ${plainText(a, 40)}` };
  }
  if (o.dryRun && o.approved.length > 0) return { error: '--approve-build-changes cannot be combined with --dry-run (a dry run never starts anything)' };
  return o;
}

/** An expected refusal: lines are plain text for the user. */
class Refusal extends Error {
  constructor(lines) {
    super(Array.isArray(lines) ? lines.join('\n') : String(lines));
    this.lines = Array.isArray(lines) ? lines : [String(lines)];
  }
}

const GATED_TAGS = ['irreversible', 'decision'];
const MAX_TABLE_ROWS = 100;
const MAX_LISTED = 20;

const argvText = (argv) => argv.map((a) => plainText(a, 120)).join(' ');

function describeError(e, root) {
  const msg = String(e?.message ?? e).split(root).join('.');
  return msg.split('\n').slice(0, 10).map((l) => plainText(l, 300));
}

/** Everything read-only that both the real run and --dry-run need; throws Refusal. */
function prepare(root) {
  if (!isGradleProject(root)) throw new Refusal(['not an Android/Gradle project: no settings.gradle(.kts) or build.gradle(.kts) in the project root (use --root <dir>)']);
  try {
    const st = fs.lstatSync(path.join(root, '.ai'));
    if (!st.isDirectory()) throw new Error('x');
  } catch {
    throw new Refusal(['no .ai/ folder in this project: run "setup" (npx android-architect init) first, then create a plan with migration-plan.js --write']);
  }
  let config;
  try {
    config = loadRunConfig(root);
  } catch (e) {
    throw new Refusal(describeError(e, root));
  }
  let eff;
  try {
    eff = effectiveAgent(config);
  } catch (e) {
    throw new Refusal(describeError(e, root));
  }
  let plan;
  try {
    plan = loadPlan(root);
  } catch (e) {
    throw new Refusal(['the migration plan cannot be used:', ...describeError(e, root)]);
  }
  return { config, eff, plan };
}

/** What would run: steps still to do, the gated ones skipped, those blocked behind them. */
function planView(plan) {
  const next = nextRunnable(plan);
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const ok = new Set(plan.steps.filter((s) => s.status === 'done').map((s) => s.id));
  const willRun = [];
  const gated = [];
  const blocked = [];
  for (const s of plan.steps) {
    if (s.status === 'done') continue;
    const isGated = s.tags.some((t) => GATED_TAGS.includes(t));
    if (isGated) gated.push({ id: s.id, tags: s.tags.filter((t) => GATED_TAGS.includes(t)) });
    else if (s.dependsOn.every((d) => ok.has(d) && byId.has(d))) {
      willRun.push(s.id);
      ok.add(s.id);
    } else blocked.push(s.id);
  }
  const doing = next.doing.map((s) => s.id);
  const nextStep = next.step ? { id: next.step.id, title: plainText(next.step.title, 120) } : null;
  return { next: nextStep, doing, willRun, gated, blocked };
}

const joinIds = (ids) => {
  const shown = ids.slice(0, MAX_LISTED).map((i) => plainText(i, 80)).join(', ');
  return ids.length > MAX_LISTED ? `${shown}, ... ${ids.length - MAX_LISTED} more` : shown;
};

/** Consent statements. `base` repeats what confirmFirstUse itself prints (used by --dry-run, which never calls it). */
function consentLines(config, eff, { base }) {
  const L = [];
  if (base) {
    L.push("Verification runs your project's Gradle build code (and may reach the network); the run config and that code run as you, as does the agent.");
    L.push('HOME and PATH are inherited, so the build code can read files such as ~/.gradle, ~/.ssh and ~/.npmrc.');
    L.push(`Agent command: ${argvText(eff.argv)}`);
    L.push(`Verification commands: ${config.verification.commands.map(argvText).join(' ; ')}`);
  }
  for (const w of agentWarnings(config)) L.push(`Warning: ${plainText(w, 300)}`);
  if (eff.unverified) L.push(`Warning: the default ${plainText(eff.kind, 20)} command line was written without access to the CLI and is unverified: check every flag against the current ${plainText(eff.kind, 20)} CLI help before you confirm.`);
  const pass = config.agent.passEnv ?? [];
  L.push(`Environment variables copied from your environment into the agent (names only, values are never shown): ${pass.length > 0 ? pass.map((n) => plainText(n, 60)).join(', ') : 'none'}`);
  const b = config.budgets;
  L.push(`Budgets: ${b.maxIterations} iterations, ${b.maxTotalTokens} tokens, ${b.maxTurnsPerStep} turns per step, ${b.maxWallClockMinutes} minutes (edit .ai/run.config.json to change them).`);
  L.push(`Run branch: a new branch named ${plainText(config.branchPrefix, 100)}-<timestamp> (the current run branch is resumed when you are on one); one commit per verified step.`);
  L.push('Nothing is pushed, merged or published. Build files the agent changes stop the run for your review before verification. Create .ai/STOP or press Ctrl-C to stop.');
  return L;
}

function planLines(config, eff, view) {
  const L = [];
  L.push(`Agent command: ${argvText(eff.argv)}`);
  L.push(`Verification commands: ${config.verification.commands.map(argvText).join(' ; ')}`);
  L.push(view.doing.length > 0 ? `Resume step: ${joinIds(view.doing)} (marked doing)` : view.next ? `Next step: ${view.next.id} (${view.next.title})` : 'Next step: none runnable');
  L.push(`Steps that will run, in order: ${view.willRun.length > 0 ? joinIds(view.willRun) : 'none'}`);
  if (view.gated.length > 0) L.push(`Gated (needs a human, skipped): ${view.gated.slice(0, MAX_LISTED).map((g) => `${plainText(g.id, 80)} [${g.tags.join(', ')}]`).join(', ')}${view.gated.length > MAX_LISTED ? ', ...' : ''}`);
  if (view.blocked.length > 0) L.push(`Blocked behind unfinished or gated steps: ${joinIds(view.blocked)}`);
  return L;
}

const GATE_LINES = [
  'Gates: the run stops for a human when a step is tagged irreversible or decision, when the agent changes build files (Gradle scripts and wrapper, buildSrc, build-logic, includeBuild, package.json, ...) or protected files, and when .ai/STOP exists.',
];

function dryRun(root, io, json) {
  const { config, eff, plan } = prepare(root);
  const view = planView(plan);
  const consent = consentLines(config, eff, { base: true });
  const plan2 = planLines(config, eff, view);
  if (json) {
    io.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      dryRun: true,
      agentArgv: eff.argv.map((a) => plainText(a, 120)),
      agentDefaultUnverified: eff.unverified === true,
      warnings: agentWarnings(config).map((w) => plainText(w, 300)),
      passEnv: (config.agent.passEnv ?? []).map((n) => plainText(n, 60)),
      budgets: { ...config.budgets },
      branchPrefix: plainText(config.branchPrefix, 100),
      verification: config.verification.commands.map((c) => c.map((a) => plainText(a, 120))),
      next: view.next,
      resume: view.doing,
      willRun: view.willRun.slice(0, 200),
      gated: view.gated.slice(0, 200),
      blocked: view.blocked.slice(0, 200),
      nothingPushed: true,
    }, null, 2)}\n`);
    return EXIT.OK;
  }
  const out = (l) => io.stdout.write(`${plainText(l, 700)}\n`);
  out('Dry run: nothing was started, written or confirmed. The first real run shows this text and asks for confirmation.');
  out('');
  out('Consent text:');
  for (const l of consent) out(`  ${l}`);
  out('');
  out('Plan:');
  for (const l of plan2) out(`  ${l}`);
  out('');
  for (const l of GATE_LINES) out(l);
  return EXIT.OK;
}

const safeRel = (p, root) => {
  if (typeof p !== 'string' || p === '') return null;
  const rel = p.split(root).join('.');
  return path.isAbsolute(rel) || rel.includes('..') ? null : plainText(rel, 200);
};

function jsonResult(res, code, root) {
  const s = sanitizeReport(res);
  return {
    ...s,
    exitCode: code,
    runId: typeof res.runId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(res.runId) ? res.runId : null,
    resumed: res.resumed === true,
    reportPath: safeRel(res.reportPath, root),
    reportError: typeof res.reportError === 'string' ? plainText(res.reportError.split(root).join('.'), 200) : null,
  };
}

function humanResult(res, code, root, out) {
  const s = sanitizeReport(res);
  out(`Outcome: ${s.outcome}`);
  out(`Reason: ${s.reason}`);
  if (s.branch) out(`Branch: ${s.branch}`);
  if (s.steps.length > 0) {
    out('Steps:');
    for (const st of s.steps.slice(0, MAX_TABLE_ROWS)) {
      out(`  ${st.id} | ${st.status} | ${st.result || '-'} | iterations ${st.iterations} | commit ${st.commit ?? '-'} | ${st.title}`);
    }
    const more = s.steps.length - Math.min(s.steps.length, MAX_TABLE_ROWS) + s.stepsOmitted;
    if (more > 0) out(`  ... ${more} more steps (see the report)`);
  }
  if (s.gated.length > 0) out(`Waiting for a human: ${s.gated.map((g) => `${g.id} [${g.tags.join(', ')}]`).join(', ')}`);
  if (s.buildFiles.length > 0) {
    out(`Build files changed by the agent: ${s.buildFiles.join(', ')}`);
    out('Review `git diff` and `git status` of exactly these files before you approve them with --approve-build-changes <hash> (the hash is in the reason above); any later edit needs a new approval.');
  }
  const rp = safeRel(res.reportPath, root);
  if (rp) out(`Report: ${rp}`);
  if (typeof res.reportError === 'string') out(`Note: ${plainText(res.reportError.split(root).join('.'), 200)}`);
  if (res.outcome !== 'refused') out('Nothing was pushed, merged or published; review the branch before you do anything with it.');
  out(`Exit code: ${code}`);
}

/** Reads one line from an interactive terminal; null on EOF or Ctrl-C. */
function askTerminal(prompt, stream) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: stream, terminal: process.stdin.isTTY === true });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    rl.on('SIGINT', () => finish(null));
    rl.on('close', () => finish(null));
    rl.question(prompt, (a) => finish(a));
  });
}

async function execute(argv, io) {
  const opts = parseArgs(argv);
  if (opts.error) {
    io.stderr.write(`${plainText(opts.error, 300)}\n${USAGE}\n`);
    return EXIT.REFUSED;
  }
  if (opts.help) {
    io.stdout.write(`${HELP}\n`);
    return EXIT.OK;
  }
  const requested = path.resolve(io.cwd ?? process.cwd(), opts.root ?? '.');
  let root = requested;
  try {
    root = fs.realpathSync(requested);
  } catch {
    io.stderr.write('not an Android/Gradle project: the project root does not exist (use --root <dir>)\n');
    return EXIT.REFUSED;
  }
  const interactive = io.interactive ?? process.stdin.isTTY === true;
  const refuse = (lines) => {
    for (const l of lines) io.stderr.write(`${plainText(l, 400)}\n`);
    return EXIT.REFUSED;
  };
  try {
    if (opts.dryRun) return dryRun(root, io, opts.json);
    const { config, eff, plan } = prepare(root);
    if (!interactive) {
      // A non-interactive stdin never confirms. Consent already recorded for this exact config + agent command is enough.
      let recorded = false;
      try {
        recorded = await confirmFirstUse(root, { confirm: async () => false, say: () => {}, config, agentArgv: eff.argv });
      } catch (e) {
        return refuse(describeError(e, root));
      }
      if (recorded !== true) {
        return refuse([
          'the first-use confirmation is needed and stdin is not an interactive terminal: run this command once from an interactive terminal and type "yes" at the prompt.',
          'There is no --yes option: consent cannot be scripted. It is recorded per clone and bound to .ai/run.config.json and the agent command (any change asks again).',
        ]);
      }
    }
    const progress = opts.json ? io.stderr : io.stdout;
    const say = (l) => progress.write(`${plainText(l, 700)}\n`);
    if (!opts.json) {
      const view = planView(plan);
      say('Effective plan (nothing has run yet):');
      for (const l of planLines(config, eff, view)) say(`  ${l}`);
      say(`Budgets: ${config.budgets.maxIterations} iterations, ${config.budgets.maxTotalTokens} tokens, ${config.budgets.maxWallClockMinutes} minutes; branch prefix ${plainText(config.branchPrefix, 100)}`);
    }
    const confirm = async () => {
      for (const l of consentLines(config, eff, { base: false })) say(l);
      if (!interactive) return false;
      const a = await (io.ask ?? ((p) => askTerminal(p, progress)))('Type "yes" to confirm and start (anything else cancels): ');
      return typeof a === 'string' && a.trim().toLowerCase() === 'yes';
    };
    const loop = io.runLoop ?? defaultRunLoop;
    let res;
    try {
      res = await loop(root, { ...(io.runOptions ?? {}), confirm, say, approvedBuildChanges: opts.approved });
    } catch (e) {
      io.stderr.write(`the run failed unexpectedly: ${describeError(e, root)[0] ?? ''}\n`);
      return EXIT.FAILED;
    }
    if (res === null || typeof res !== 'object') {
      io.stderr.write('the run returned no result\n');
      return EXIT.FAILED;
    }
    let code = typeof res.outcome === 'string' && Object.hasOwn(OUTCOME_EXIT, res.outcome) ? OUTCOME_EXIT[res.outcome] : EXIT.FAILED;
    // A finished run whose report could not be written is not a clean success.
    if (code === EXIT.OK && typeof res.reportError === 'string') code = EXIT.FAILED;
    if (opts.json) io.stdout.write(`${JSON.stringify(jsonResult(res, code, root), null, 2)}\n`);
    else humanResult(res, code, root, (l) => io.stdout.write(`${plainText(l, 700)}\n`));
    return code;
  } catch (e) {
    if (e instanceof Refusal) return refuse(e.lines);
    io.stderr.write(`the run failed unexpectedly: ${describeError(e, root)[0] ?? ''}\n`);
    return EXIT.FAILED;
  }
}

/**
 * Runs the command and resolves to its exit code (the caller sets process.exitCode). Never throws.
 * `io` is a test seam: { stdout, stderr, cwd, interactive, ask(prompt), runLoop, runOptions }; the CLI never fills it.
 */
export async function main(argv, io = {}) {
  const full = { stdout: io.stdout ?? process.stdout, stderr: io.stderr ?? process.stderr, ...io };
  try {
    return await execute(argv, full);
  } catch {
    try {
      full.stderr.write('the run failed unexpectedly\n');
    } catch {
      // nothing left to report to
    }
    return EXIT.FAILED;
  }
}

const isMain = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (process.argv[1] && isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
