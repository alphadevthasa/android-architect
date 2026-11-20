// The autonomous run loop. The engine decides every outcome from facts it observed itself (exit codes, timers, git, file
// digests, its own verification run); what the agent says is data. One iteration = one agent invocation for one step.
// Contract (details in the doc comments below):
//   runLoop(root, { agent, verifier, git, now, say, confirm, signal, agentTimeoutMs }) -> RunResult (a plain object).
// All I/O goes through those seams so tests can drive it with fake agents; nothing here calls process.exit, pushes,
// merges, publishes or touches the network (git goes through rungit.runGit, which refuses every network subcommand).
import * as rungit from './rungit.js';
import { RunRefusal, plainText } from './rungit.js';
import { loadRunConfig, RUN_CONFIG_FILE } from './runconfig.js';
import { loadPlan, nextRunnable, setStatus, ROADMAP_FILE } from './runplan.js';
import { runAgent, newNonce, usageFloor, effectiveAgent, agentWarnings } from './agent.js';
import { runVerification, killLiveGroups } from './runverify.js';
import { buildStepBrief } from './stepbrief.js';
import { writeGenerated } from './aidir.js';
import { redact } from './redact.js';
import { stripUnsafe } from './mdtext.js';
import fs from 'node:fs';
import path from 'node:path';
import { stopPresent, acquireLock, takeSnapshot, diffSnapshots, buildGate, resumeChecks, ignoredBuildMap, includeBuildDirs } from './runguard.js';
import { writeRunReport } from './runreport.js';

export const OUTCOMES = Object.freeze(['done', 'budget', 'no-progress', 'repeated-error', 'verification-failed', 'needs-human', 'stopped', 'failed', 'refused', 'tampered', 'interrupted']);
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_AGENT_TIMEOUT_MS = 1000;
const VERIFY_GRACE_MS = 60 * 1000;
const MAX_PREVIOUS_FAILURE = 8 * 1024;
const MAX_LOG_TAIL = 32 * 1024;
const MAX_LISTED = 10;
const STOP_POLL_MS = 1000;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/** Fixed reason phrases (tests assert them). Dynamic parts are step ids (grammar-checked) or budget names. */
export const REASONS = Object.freeze({
  done: 'all roadmap steps are done',
  stopped: 'the .ai/STOP file is present',
  declined: 'the first-use confirmation was declined',
  agentTimeout: 'the agent timed out and was killed',
  agentSignal: 'the agent was ended by a signal',
  noChange: 'the agent reported done but changed nothing',
  lockLost: 'the run lock was taken over by another process',
  drift: 'the run config or its confirmation changed during the run; start the run again',
  budget: (name, limit) => `budget reached: ${name} (${limit})`,
  interrupted: (sig) => `the run was interrupted (${sig})`,
  tampered: (what) => `the agent changed protected files (${what}); nothing was committed`,
  agentFailedTwice: (id) => `step ${id} failed twice in a row (the agent did not report done)`,
  verifyFailedTwice: (id) => `verification failed twice for step ${id}`,
  repeatedError: (id) => `the same error repeated on step ${id} after an earlier step failed the same way`,
  buildFiles: (n, hash) => `build files changed: ${n} — review, then rerun with --approve-build-changes ${hash}`,
  stopRemoved: 'the .ai/STOP file was removed while the agent was running',
  agentReported: (id, status) => `the agent reported ${status} for step ${id}`,
});

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString());
const stampOf = (ms) => iso(ms).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Budget exit conditions, one place: { outcome: 'budget', reason } or null. `state` = { iterations, tokens, startedMs }.
 * Iterations and tokens are checked before an iteration starts (a started iteration is always finished and verified).
 */
export function budgetExit(config, state, nowMs) {
  const b = config.budgets;
  if (state.iterations >= b.maxIterations) return { outcome: 'budget', reason: REASONS.budget('maxIterations', b.maxIterations) };
  if (state.tokens >= b.maxTotalTokens) return { outcome: 'budget', reason: REASONS.budget('maxTotalTokens', b.maxTotalTokens) };
  if (nowMs - state.startedMs >= b.maxWallClockMinutes * 60_000) return { outcome: 'budget', reason: REASONS.budget('maxWallClockMinutes', b.maxWallClockMinutes) };
  return null;
}

const lastChars = (s, n) => {
  const t = typeof s === 'string' ? s : '';
  return t.length > n ? t.slice(-n) : t;
};

/**
 * Runs the loop in `root` (a git repository with .ai/migration/plan.json and roadmap.md) and returns
 *   { outcome, reason, steps, branch, startedAt, endedAt, iterations, usage: { totalTokens, estimated }, gated,
 *     reportPath, reportError, runId, resumed }
 * outcome is one of OUTCOMES. Never throws for run conditions (refusals included); never pushes, merges or publishes.
 * Options (all optional):
 *   agent(root, config, { brief, step, nonce, turns, timeoutMs, now, runId, n }) -> like runAgent (default runAgent)
 *   verifier(root, config, { timeoutMs })                                       -> like runVerification
 *   git         overrides of rungit exports (startRunBranch, commitStep, hasChanges, confirmFirstUse, runGit)
 *   now()       ms clock (default Date.now); say(line) progress lines (plain text); confirm() async -> true to accept the
 *               first-use consent (default: decline); signal AbortSignal (same effect as SIGINT); agentTimeoutMs.
 * Configuration is always read from .ai/run.config.json on disk (the same bytes the consent is bound to); it is re-read,
 * re-hashed and the consent re-checked before every iteration and before every commit, so a change mid-run stops the loop.
 * Lifecycle per iteration: reload the plan; a `doing` step is resumed (or only marked done when its commit exists on the
 * run branch), else the next runnable step is marked doing (uncommitted); brief with a fresh nonce; agent; guards;
 * on a done claim the RUNNER verifies, and only a passing verification (plus no STOP, no tampering, same config) leads to
 * doing -> done and ONE commit holding the code and the roadmap change. A failed verification gives the agent ONE more try
 * with the redacted failure tail; the second failure stops with `verification-failed` and leaves the step `doing`.
 * Exit decisions: done (nothing left), budgets, no-progress (done claim without a change, or an agent failure twice in a row),
 * repeated-error (the same error signature again on another step), needs-human (gated/blocked steps remain or the agent
 * said blocked/needs-human), stopped (.ai/STOP, any file type), failed (agent timed out / was killed / could not run),
 * tampered, refused (start refusals, config or consent drift, lock lost, commit refused), interrupted (SIGINT/SIGTERM/abort).
 * A stop leaves the `doing` row and any uncommitted changes in the tree for the human; the runner never resets or cleans.
 */
export async function runLoop(root, options = {}) {
  const git = { ...rungit, ...(options.git ?? {}) };
  const agent = options.agent ?? runAgent;
  const verifier = options.verifier ?? runVerification;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const rootText = String(root);
  const plain = (e, max = 300) => plainText(String(e?.message ?? e).split(rootText).join('.'), max);
  const say = (m) => {
    try {
      if (typeof options.say === 'function') options.say(plainText(String(m), 400));
    } catch {
      // a broken sink never stops the run
    }
  };

  const startedMs = now();
  const result = { buildFiles: [], outcome: 'failed', reason: '', steps: [], branch: null, startedAt: iso(startedMs), endedAt: null, iterations: 0, usage: { totalTokens: 0, estimated: false }, gated: [], reportPath: null, reportError: null, runId: null, resumed: false };
  const state = { iterations: 0, tokens: 0, startedMs };
  const warnings = [];
  const entries = new Map();
  const attempts = new Map(); // step id -> { agent, verify }
  const previous = new Map(); // step id -> failure text for the next brief
  let lastFail = null; // { sig, id }
  let started = false;
  let pendingVerify = false;
  let snapshot = null;
  let ignoredBase = null;
  let logText = '';
  let lock = null;
  let config = null;
  let agentArgv = [];
  let interrupted = null;
  let wake;
  const interruptP = new Promise((r) => {
    wake = r;
  });
  const INT = Symbol('interrupted');
  const STP = Symbol('stop');
  let stopSeen = false;
  let wakeStop;
  const stopP = new Promise((r) => {
    wakeStop = r;
  });
  const raceInterrupt = async (p) => {
    const q = Promise.resolve(p).then(() => {}, () => {});
    const out = await Promise.race([Promise.resolve(p), interruptP.then(() => INT), stopP.then(() => STP)]);
    // After an interrupt give the killed process groups a moment to be gone before the report is written; a second
    // signal during this wait ends the process at once.
    if (out === INT) {
      let timer;
      await Promise.race([q, new Promise((r) => { timer = setTimeout(r, options.interruptGraceMs ?? 3000); })]);
      clearTimeout(timer);
    }
    return out;
  };
  // While the agent or verification runs, .ai/STOP is polled; when it shows up the process groups are killed at once.
  let poller = null;
  const pollStop = () => {
    if (stopPresent(root)) {
      stopSeen = true;
      killLiveGroups('SIGKILL');
      wakeStop();
    }
  };
  const startPoll = () => {
    poller = setInterval(pollStop, options.stopPollMs ?? STOP_POLL_MS);
    poller.unref?.();
  };
  const endPoll = () => {
    clearInterval(poller);
    poller = null;
  };
  const onSignal = (sig) => {
    if (interrupted) {
      // a second signal: default handling, immediately
      for (const [s, h] of handlers) process.off(s, h);
      killLiveGroups('SIGKILL');
      if (SIGNALS.includes(sig)) process.kill(process.pid, sig); // 'abort' is synthetic: nothing to re-raise
      return;
    }
    interrupted = sig;
    killLiveGroups('SIGKILL');
    say(`interrupt received (${sig}); stopping; send the signal again to exit at once`);
    wake();
  };
  const handlers = SIGNALS.map((sig) => [sig, () => onSignal(sig)]);
  const onAbort = () => onSignal('abort');

  const stop = (outcome, reason) => ({ outcome, reason });
  const intStop = () => stop('interrupted', REASONS.interrupted(interrupted));
  const baseState = { remaining: { todo: 0, doing: 0, done: 0 } };

  // ---------- config and consent, re-checked all run long ----------
  async function drift() {
    let reread;
    try {
      reread = loadRunConfig(root);
    } catch (e) {
      return stop('refused', `${RUN_CONFIG_FILE} is no longer valid: ${plain(e, 200)}`);
    }
    if (JSON.stringify(reread) !== JSON.stringify(config)) return stop('refused', REASONS.drift);
    try {
      const ok = await git.confirmFirstUse(root, { confirm: async () => false, say: () => {}, config, agentArgv });
      if (ok !== true) return stop('refused', REASONS.drift);
    } catch (e) {
      return stop('refused', plain(e, 200));
    }
    return null;
  }

  /** Checks that apply at the top of an iteration (no snapshot yet). */
  async function topGuards() {
    if (interrupted) return intStop();
    if (stopPresent(root)) return stop('stopped', REASONS.stopped);
    const d = await drift();
    if (d) return d;
    if (!lock.holds()) return stop('refused', REASONS.lockLost);
    return null;
  }

  const topOf = () => {
    try {
      return git.runGit(root, ['rev-parse', '--show-toplevel']).trim() || root;
    } catch {
      return root;
    }
  };

  /** Guards after the agent or verification: interruption, tampering (before anything else), STOP, config drift, lock. */
  const guard = async () => {
    if (interrupted) return intStop();
    if (stopSeen && !stopPresent(root)) return stop('tampered', REASONS.stopRemoved);
    const changed = diffSnapshots(snapshot, takeSnapshot(git, root));
    if (changed.length > 0) return stop('tampered', REASONS.tampered(changed.join(', ')));
    return topGuards();
  };

  // ---------- run folder and per-iteration records ----------
  const runIdFor = () => {
    const base = `r${stampOf(startedMs)}`;
    for (let i = 1; i < 100; i++) {
      const id = i === 1 ? base : `${base}-${i}`;
      try {
        fs.lstatSync(path.join(root, '.ai', 'runs', id));
      } catch {
        return id;
      }
    }
    return `${base}-${process.pid}`;
  };
  const writeIteration = (n, data, logText) => {
    try {
      writeGenerated(root, {
        [`runs/${result.runId}/iteration-${n}.json`]: `${JSON.stringify(data, null, 2)}\n`,
        [`runs/${result.runId}/iteration-${n}.log`]: lastChars(logText, MAX_LOG_TAIL),
      });
    } catch (e) {
      warnings.push(`iteration ${n} record could not be written: ${plain(e, 120)}`);
    }
  };
  const entryFor = (step) => {
    let e = entries.get(step.id);
    if (!e) {
      e = { id: step.id, title: plainText(step.title ?? '', 120), status: 'doing', result: '', iterations: 0, commit: null, summary: '', diffFiles: [] };
      entries.set(step.id, e);
      result.steps.push(e);
    }
    return e;
  };

  // ---------- commit-based resume (ruling 3) ----------
  let subjects = null;
  const committed = (id, baseCommit, branch, plan) => {
    if (subjects === null) {
      subjects = [];
      let base = baseCommit;
      if (result.resumed) {
        // The oldest reflog entry of the run branch is its creation point; without a reflog nothing is resumed by commit.
        try {
          const lines = git.runGit(root, ['log', '-g', '--format=%H', '-n', '1000', `refs/heads/${branch}`, '--']).split('\n').filter(Boolean);
          base = lines.length > 0 ? lines[lines.length - 1] : null;
        } catch {
          base = null;
        }
      }
      if (base && /^[0-9a-f]{40,64}$/.test(base)) {
        try {
          subjects = git.runGit(root, ['log', '--format=%s', '-n', '5000', `${base}..HEAD`, '--']).split('\n');
        } catch {
          subjects = [];
        }
      }
    }
    const prefix = `feat(migration): ${id}`;
    const cutAt = 72; // commitStep cuts subjects at 72 characters
    if (prefix.length >= cutAt) {
      // The subject holds only a cut prefix of the id: match that, unless another step shares it (then it proves nothing).
      const cut = prefix.slice(0, cutAt).trimEnd();
      if (plan.steps.some((o) => o.id !== id && `feat(migration): ${o.id}`.startsWith(cut))) return false;
      return subjects.some((s) => s === cut);
    }
    return subjects.some((s) => s.startsWith(prefix) && (s.length === prefix.length || s.startsWith(': ', prefix.length)));
  };

  // ---------- the loop ----------
  async function loop(branchInfo) {
    // Hard bound on passes (iterations plus resume-only passes): a roadmap full of `doing` rows cannot keep it spinning.
    const maxPasses = config.budgets.maxIterations * 2 + 10;
    for (let pass = 0; ; pass++) {
      let verifyOnly = false;
      if (pass >= maxPasses) return stop('budget', REASONS.budget('maxIterations', config.budgets.maxIterations));
      const pre = await topGuards();
      if (pre) return pre;

      let plan;
      try {
        plan = loadPlan(root);
      } catch (e) {
        return stop('failed', `the plan cannot be loaded: ${plain(e, 250)}`);
      }
      const nr = nextRunnable(plan);
      const counts = { todo: 0, doing: 0, done: 0 };
      for (const s of plan.steps) counts[s.status]++;
      baseState.remaining = counts;
      if (nr.done) return stop('done', REASONS.done);

      let step = null;
      const doing = nr.doing[0];
      if (doing) {
        const byId = new Map(plan.steps.map((s) => [s.id, s]));
        const gated = doing.tags.some((t) => t === 'irreversible' || t === 'decision');
        if (gated || doing.dependsOn.some((d) => byId.get(d)?.status !== 'done')) {
          result.gated = [{ id: doing.id, tags: gated ? doing.tags : ['blocked'] }];
          return stop('needs-human', `step ${doing.id} is marked doing but ${gated ? 'needs a human decision' : 'depends on unfinished steps'}`);
        }
        if (committed(doing.id, branchInfo.baseCommit, branchInfo.branch, plan)) {
          if (pendingVerify) {
            pendingVerify = false;
            return stop('refused', `step ${doing.id} already has its commit on the run branch; the approved changes belong to something else, so nothing was verified`);
          }
          try {
            setStatus(root, doing.id, 'done', 'doing');
            git.commitStep(root, doing, doing.title);
          } catch (e) {
            return stop('refused', `cannot record step ${doing.id} as done: ${plain(e, 200)}`);
          }
          const e = entryFor(doing);
          e.status = 'done';
          e.result = 'resumed: commit already on the run branch';
          say(`step ${doing.id} already has its commit on the run branch; marked done`);
          continue;
        }
        step = doing;
        verifyOnly = pendingVerify;
        pendingVerify = false;
      } else if (pendingVerify) {
        return stop('refused', 'build changes were approved but no step is marked doing; nothing to verify');
      } else if (nr.step) step = nr.step;
      else {
        const list = nr.gated ?? plan.steps.filter((s) => s.status !== 'done' && s.tags.some((t) => t === 'irreversible' || t === 'decision'));
        result.gated = list.slice(0, MAX_LISTED).map((s) => ({ id: s.id, tags: s.tags.filter((t) => t === 'irreversible' || t === 'decision') }));
        const shown = result.gated.map((g) => `${g.id} (${g.tags.join(', ')})`).join(', ');
        const more = list.length > MAX_LISTED ? ` and ${list.length - MAX_LISTED} more` : '';
        return stop('needs-human', list.length > 0 ? `steps need a human: ${shown}${more}` : 'no step can run: every remaining step waits for another step');
      }

      const b = budgetExit(config, state, now());
      if (b) return b;

      // ----- one iteration -----
      const n = ++state.iterations;
      result.iterations = n;
      const t0 = now();
      const entry = entryFor(step);
      entry.iterations++;
      const rec = { iteration: n, step: step.id, status: 'none', exitCode: null, durationMs: 0, usage: null, verification: null, commit: null, diffFiles: [] };
      logText = '';
      try {
        const out = await iterate(step, entry, rec, n, plan, verifyOnly);
        if (out) return out;
      } finally {
        rec.durationMs = Math.max(0, Math.round(now() - t0));
        writeIteration(n, rec, logText);
      }
    }
  }

  async function iterate(step, entry, rec, n, plan, verifyOnly = false) {
    const log = (t) => {
      logText += t;
    };
    say(`iteration ${n}: step ${step.id}: ${plainText(step.title ?? '', 100)}`);
    if (step.status === 'todo') setStatus(root, step.id, 'doing', 'todo'); // uncommitted on purpose (ruling 3)
    if (verifyOnly) {
      // Verify-only resume (ruling 19): the changes in the tree were reviewed and approved by hash; no agent runs.
      const bad = resumeChecks(git, root, step.id);
      if (bad) return stop(bad.outcome, bad.reason);
      snapshot = takeSnapshot(git, root);
      ignoredBase = null; // no baseline on a resume: every ignored build file counts
      say(`step ${step.id}: approved build changes; verifying the existing changes without running the agent`);
      entry.result = 'verify-only resume';
      rec.status = 'verify-only';
      return verifyAndCommit(step, entry, rec, config.budgets.maxWallClockMinutes * 60_000 - (now() - startedMs), log);
    }
    snapshot = takeSnapshot(git, root);
    try {
      ignoredBase = ignoredBuildMap(git, root, includeBuildDirs(topOf(), root));
    } catch {
      ignoredBase = null; // the gate reports the same problem
    }
    const nonce = newNonce();
    const brief = buildStepBrief(root, { step, plan, config, nonce, previousFailure: previous.get(step.id) });
    const wallLeft = config.budgets.maxWallClockMinutes * 60_000 - (now() - startedMs);
    const timeoutMs = Math.max(MIN_AGENT_TIMEOUT_MS, Math.min(options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS, wallLeft));

    let r;
    startPoll();
    try {
      r = await raceInterrupt(agent(root, config, { brief, step, nonce, turns: config.budgets.maxTurnsPerStep, timeoutMs, now: now(), runId: result.runId, n }));
    } catch (e) {
      endPoll();
      return stop('failed', `the agent could not run: ${plain(e, 200)}`);
    }
    endPoll();
    if (r === INT) return intStop();
    if (r === STP) {
      rec.status = 'stopped';
      return stopPresent(root) ? stop('stopped', REASONS.stopped) : stop('tampered', REASONS.stopRemoved);
    }

    // runner-observed facts only
    const exitCode = Number.isSafeInteger(r?.exitCode) ? r.exitCode : null;
    const timedOut = r?.timedOut === true;
    const signal = typeof r?.signal === 'string' && r.signal !== '' ? r.signal : null;
    const floor = usageFloor(config);
    const reported = Number.isSafeInteger(r?.usage?.totalTokens) && r.usage.totalTokens >= 0 ? r.usage.totalTokens : null;
    const spent = reported === null ? floor : Math.max(reported, floor);
    state.tokens += spent;
    result.usage = { totalTokens: state.tokens, estimated: result.usage.estimated || reported === null };
    rec.exitCode = exitCode;
    rec.usage = { totalTokens: spent, estimated: reported === null };
    log(`agent exit: ${exitCode === null ? 'none' : exitCode}${signal ? ` signal ${signal}` : ''}${timedOut ? ' (timed out)' : ''}\n--- agent output tail (redacted, capped) ---\n${lastChars(plainTail(r?.outputTail), MAX_LOG_TAIL / 2)}\n`);

    // Guards after the agent: interruption, tampering (before anything else), STOP, config drift, lock.
    const g1 = await guard();
    if (g1) {
      rec.status = g1.outcome;
      return g1;
    }

    if (timedOut) return fail(rec, entry, 'timeout', stop('failed', REASONS.agentTimeout));
    if (signal) return fail(rec, entry, 'signal', stop('failed', REASONS.agentSignal));
    const st = r?.status;
    const claimed = st?.ok === true && st.status && typeof st.status === 'object' ? st.status.status : null;
    if (st?.ok === true && st.status) entry.summary = plainText(st.status.summary ?? '', 300);
    rec.status = claimed ?? 'invalid';

    if (claimed === 'blocked' || claimed === 'needs-human') {
      entry.result = claimed;
      return stop('needs-human', REASONS.agentReported(step.id, claimed));
    }
    if (claimed !== 'done' || (exitCode !== null && exitCode !== 0)) {
      const kind = claimed === 'failed' ? 'failed' : exitCode !== null && exitCode !== 0 ? `exit-${exitCode}` : 'invalid-status';
      return agentFailure(step, entry, kind, st?.ok === false ? st.reason : `agent ${kind}`);
    }

    return verifyAndCommit(step, entry, rec, wallLeft, log);
  }

  /** The runner's own checks after a done claim (or on a verify-only resume): changes, build gate, verification, commit. */
  async function verifyAndCommit(step, entry, rec, wallLeft, log) {
    // The agent says done: the runner checks (never the claim).
    if (!git.hasChanges(root, { ignore: [ROADMAP_FILE], ignoreDirs: ['.ai/migration'] })) {
      entry.result = 'no change';
      return stop('no-progress', REASONS.noChange);
    }
    // Build-code gate: verification executes build code, so build files the agent touched need a human's approval first.
    let gate;
    try {
      gate = buildGate(git, root, config, options.approvedBuildChanges, ignoredBase);
    } catch (e) {
      if (e?.needsHuman) return stop('needs-human', plain(e, 200));
      return stop('failed', `the build files could not be checked: ${plain(e, 200)}`);
    }
    if (gate) {
      result.buildFiles = gate.files.slice(0, 20).map((f) => plainText(f, 120));
      entry.result = 'build files changed';
      return stop('needs-human', REASONS.buildFiles(gate.count, gate.hash));
    }
    let v;
    startPoll();
    try {
      v = await raceInterrupt(verifier(root, config, { timeoutMs: config.verification.timeoutSeconds * 1000, totalMs: Math.max(VERIFY_GRACE_MS, wallLeft) }));
    } catch (e) {
      endPoll();
      return stop('failed', `verification could not run: ${plain(e, 200)}`);
    }
    endPoll();
    if (v === INT) return intStop();
    if (v === STP) return stopPresent(root) ? stop('stopped', REASONS.stopped) : stop('tampered', REASONS.stopRemoved);
    const results = Array.isArray(v?.results) ? v.results : [];
    const signatures = results.map((x) => (typeof x?.signature === 'string' ? x.signature : '')).filter(Boolean).slice(0, 10);
    const ok = v?.ok === true;
    rec.verification = { ok, signatures };
    for (const x of results.slice(0, 20)) {
      log(`--- verification: ${plainText((Array.isArray(x?.argv) ? x.argv.join(' ') : ''), 200)} (exit ${x?.exitCode ?? 'none'}${x?.timedOut ? ', timed out' : ''}) ---\n${lastChars(plainTail(x?.tail), 8 * 1024)}\n`);
    }
    const g2 = await guard();
    if (g2) return g2;

    if (!ok) {
      const a = attemptsOf(step.id);
      a.verify++;
      const sig = signatures.length > 0 ? signatures.join('|') : `verify:${plainText(v?.reason ?? 'failed', 60)}`;
      entry.result = 'verification failed';
      if (a.verify >= 2) return stop('verification-failed', REASONS.verifyFailedTwice(step.id));
      if (lastFail && lastFail.sig === sig && lastFail.id !== step.id) return stop('repeated-error', REASONS.repeatedError(step.id));
      lastFail = { sig, id: step.id };
      const last = results[results.length - 1];
      previous.set(step.id, plainTail(`${v?.reason ?? ''}\n$ ${Array.isArray(last?.argv) ? last.argv.join(' ') : ''}\nexit ${last?.exitCode ?? 'none'}${last?.timedOut ? ' (timed out)' : ''}\n${last?.tail ?? ''}`).slice(-MAX_PREVIOUS_FAILURE));
      say(`step ${step.id}: verification failed; the agent gets one more try`);
      return null;
    }

    // Verified: doing -> done and one commit (code + roadmap). STOP is checked again right before the commit.
    setStatus(root, step.id, 'done', 'doing');
    const revert = () => {
      try {
        setStatus(root, step.id, 'doing', 'done');
      } catch {
        // the human sees the row; nothing else to do
      }
    };
    if (stopPresent(root)) {
      revert();
      return stop('stopped', REASONS.stopped);
    }
    let c;
    try {
      c = git.commitStep(root, step, step.title);
    } catch (e) {
      revert();
      return stop(e?.needsHuman ? 'needs-human' : e instanceof RunRefusal ? 'refused' : 'failed', `the commit was refused: ${plain(e, 200)}`);
    }
    if (c === null) {
      revert();
      return stop('failed', 'nothing was committed');
    }
    entry.status = 'done';
    entry.commit = c.commit;
    entry.result = 'verified and committed';
    entry.diffFiles = (c.filesChanged ?? []).slice(0, 20).map((f) => plainText(f, 120));
    rec.commit = c.commit;
    rec.diffFiles = entry.diffFiles;
    attempts.delete(step.id);
    previous.delete(step.id);
    say(`step ${step.id}: verified and committed`);
    return null;
  }

  const attemptsOf = (id) => {
    let a = attempts.get(id);
    if (!a) {
      a = { agent: 0, verify: 0 };
      attempts.set(id, a);
    }
    return a;
  };
  const fail = (rec, entry, kind, s) => {
    rec.status = kind;
    entry.result = kind;
    return s;
  };
  /** An agent failure that can be retried once (failed, invalid status, non-zero exit). */
  function agentFailure(step, entry, kind, why) {
    const a = attemptsOf(step.id);
    a.agent++;
    entry.result = kind;
    if (a.agent >= 2) return stop('no-progress', REASONS.agentFailedTwice(step.id));
    const sig = `agent:${kind}`;
    if (lastFail && lastFail.sig === sig && lastFail.id !== step.id) return stop('repeated-error', REASONS.repeatedError(step.id));
    lastFail = { sig, id: step.id };
    previous.set(step.id, `The agent run ended without a valid "done" status (${plainText(why ?? kind, 200)}). Continue the step and end with the status block.`);
    say(`step ${step.id}: the agent did not report done (${kind}); one more try`);
    return null;
  }

  // ---------- run ----------
  let outcome;
  try {
    try {
      config = loadRunConfig(root);
      const eff = effectiveAgent(config);
      agentArgv = eff.argv;
      for (const w of agentWarnings(config)) {
        warnings.push(w);
        say(`warning: ${w}`);
      }
      const pass = config.agent.passEnv ?? [];
      if (pass.length > 0) say(`Environment variables copied to the agent from your environment: ${pass.join(', ')}`);
      lock = await acquireLock(git, root);
      const ok = await git.confirmFirstUse(root, { confirm: typeof options.confirm === 'function' ? options.confirm : async () => false, say, config, agentArgv });
      if (ok !== true) throw new RunRefusal(REASONS.declined);
      // Ruling 19: a dirty tree is accepted on an existing run branch only when its build files hash to an approved hash.
      const approved = Array.isArray(options.approvedBuildChanges) ? options.approvedBuildChanges : [];
      let approvalMatches = false;
      if (approved.length > 0) {
        try {
          const gate = buildGate(git, root, config, []);
          approvalMatches = gate !== null && approved.includes(gate.hash);
        } catch {
          approvalMatches = false;
        }
      }
      let br;
      try {
        br = git.startRunBranch(root, { branchPrefix: config.branchPrefix, now: startedMs, protectedBranches: config.protectedBranches, resumeDirtyOk: [ROADMAP_FILE], allowDirty: approvalMatches });
      } catch (e) {
        if (approved.length > 0 && !approvalMatches && e instanceof RunRefusal && e.message.includes('not clean')) {
          throw new RunRefusal('the approved build-change hash does not match the current build files (they changed, or none are changed); review them again and use the new hash');
        }
        throw e;
      }
      pendingVerify = approvalMatches && br.resumed === true;
      result.branch = br.branch;
      result.resumed = br.resumed === true;
      result.runId = runIdFor();
      started = true;
      say(`${br.resumed ? 'resuming on' : 'working on new'} branch ${br.branch}; nothing is pushed, merged or published`);
      for (const [sig, h] of handlers) process.on(sig, h);
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }
      outcome = await loop(br);
    } catch (e) {
      outcome = e instanceof RunRefusal ? stop('refused', plain(e, 300)) : stop('failed', `internal error: ${plain(e, 200)}`);
    }
  } finally {
    endPoll();
    for (const [sig, h] of handlers) process.off(sig, h);
    options.signal?.removeEventListener?.('abort', onAbort);
    killLiveGroups('SIGKILL');
    try {
      lock?.release();
    } catch {
      // a lock that cannot be removed is stale by pid anyway
    }
  }

  result.outcome = outcome.outcome;
  result.reason = outcome.reason;
  result.endedAt = iso(now());
  if (started) {
    try {
      const final = loadPlan(root);
      const c = { todo: 0, doing: 0, done: 0 };
      for (const s of final.steps) c[s.status]++;
      baseState.remaining = c;
    } catch {
      // keep the last known counts
    }
    try {
      result.reportPath = writeRunReport(root, result.runId, { ...result, remaining: baseState.remaining, warnings }).path;
    } catch (e) {
      result.reportError = `the report could not be written: ${plain(e, 150)}`;
      say(result.reportError);
    }
  }
  say(`run ended: ${result.outcome}: ${result.reason}`);
  return result;
}

/** Redacted text with control characters (except newline and tab) and bidi controls removed, capped to its last 64 KB. */
function plainTail(s) {
  const t = lastChars(typeof s === 'string' ? s : '', 64 * 1024);
  let out = '';
  for (const ch of t) {
    const c = ch.charCodeAt(0);
    out += c === 10 || c === 9 || (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f)) ? ch : ' ';
  }
  return redact(stripUnsafe(out)).text;
}
