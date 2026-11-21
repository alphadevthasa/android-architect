import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderRoadmap } from '../skill/scripts/lib/migplan.js';
import { runLoop, budgetExit, REASONS, OUTCOMES } from '../skill/scripts/lib/runloop.js';
import { runAgent } from '../skill/scripts/lib/agent.js';
import { DEFAULT_RUN_CONFIG } from '../skill/scripts/lib/runconfig.js';
import { killLiveGroups } from '../skill/scripts/lib/runverify.js';
import { startRunBranch, commitStep } from '../skill/scripts/lib/rungit.js';
import { setStatus } from '../skill/scripts/lib/runplan.js';
import { stopPresent, acquireLock } from '../skill/scripts/lib/runguard.js';
import * as rungit from '../skill/scripts/lib/rungit.js';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'stub-agent.mjs');
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'run-loop-child.mjs');
const tmps = [];
after(() => {
  killLiveGroups();
  tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
const FAKE_SECRET = 'AKIAIOSFODNN7EXAMPLE';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const S = (id, title, extra = {}) => ({ id, title, track: 'enabling', dimension: 'ui', from: 'x', to: 'y', dependsOn: [], tags: [], verification: [], rollback: 'revert', evidence: [], ...extra });
const mkPlan = (steps) => ({ schemaVersion: 1, steps, tracks: { enabling: steps.map((s) => s.id), data: [], features: [] }, notes: [] });
const CHAIN = mkPlan([S('a', 'First'), S('b', 'Second', { dependsOn: ['a'] })]);

/** A repo on branch `feature` (not a default branch) with plan, roadmap and optional run config, all committed. */
function project(plan = CHAIN, { config = null, extra = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-loop-')));
  tmps.push(root);
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'user.name', 't');
  g(root, 'config', 'user.email', 't@example.invalid');
  fs.mkdirSync(path.join(root, '.ai/migration'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ai/migration/plan.json'), JSON.stringify(plan));
  fs.writeFileSync(path.join(root, '.ai/migration/roadmap.md'), renderRoadmap(plan));
  if (config) fs.writeFileSync(path.join(root, '.ai/run.config.json'), JSON.stringify({ schemaVersion: 1, ...config }));
  fs.writeFileSync(path.join(root, 'README.md'), '# t\n');
  for (const [rel, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'init');
  g(root, 'switch', '-q', '-c', 'feature');
  return root;
}
const roadmap = (root) => fs.readFileSync(path.join(root, '.ai/migration/roadmap.md'), 'utf8');
const rowStatus = (root, id) => roadmap(root).split('\n').find((l) => l.startsWith(`| \`${id}\` |`))?.split('|').slice(-2, -1)[0].trim();
const commits = (root) => g(root, 'log', '--format=%s').split('\n').filter(Boolean);
const clean = (root) => g(root, 'status', '--porcelain', '--', '.', ':(exclude).ai/runs').trim();
const safe = (id) => id.replace(/[^a-z0-9]/g, '_');

const reply = (stepId, status = 'done', over = {}) => ({
  status: { ok: true, status: { step: stepId, status, summary: 'did it', filesChanged: [], verification: 'ok' } },
  usage: { totalTokens: 10 }, exitCode: 0, signal: null, timedOut: false, outputTail: 'out', ...over,
});
/** An agent that writes one file per step, then says done. `after(root, opts)` may do more (and may return a reply). */
const worker = (after = null, calls = []) => async (root, _config, opts) => {
  calls.push(opts);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', `${safe(opts.step.id)}.kt`), `// ${opts.step.id} ${calls.length}\n`);
  return (after && (await after(root, opts))) || reply(opts.step.id);
};
const okVerifier = async () => ({ ok: true, results: [{ argv: ['./gradlew', 'test'], exitCode: 0, tail: 'BUILD SUCCESSFUL', signature: '' }] });
const failVerifier = (sig = 'sig1', tail = 'error: it broke') => async () => ({ ok: false, results: [{ argv: ['./gradlew', 'test'], exitCode: 1, tail, signature: sig }] });

const go = (root, opts = {}) => {
  const said = [];
  const p = runLoop(root, { confirm: async () => true, say: (m) => said.push(m), agent: worker(), verifier: okVerifier, ...opts });
  return p.then((r) => Object.assign(r, { said }));
};
const runDir = (root, r) => path.join(root, '.ai/runs', r.runId);
const readReport = (root, r) => ({ md: fs.readFileSync(path.join(runDir(root, r), 'report.md'), 'utf8'), json: JSON.parse(fs.readFileSync(path.join(runDir(root, r), 'report.json'), 'utf8')) });

// ---------- exit conditions ----------
test('done: every step verified and committed once, roadmap updated in the same commit, report written, nothing pushed', async () => {
  const root = project();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-loop-remote-'));
  tmps.push(remote);
  g(remote, 'init', '-q', '--bare');
  g(root, 'remote', 'add', 'origin', remote);
  g(root, 'push', '-q', 'origin', 'feature');
  const before = g(remote, 'for-each-ref').trim();
  const r = await go(root);
  assert.equal(r.outcome, 'done');
  assert.equal(r.reason, REASONS.done);
  assert.match(r.branch, /^android-architect\/run-/);
  assert.deepEqual(r.steps.map((s) => [s.id, s.status]), [['a', 'done'], ['b', 'done']]);
  assert.ok(r.steps.every((s) => /^[0-9a-f]{40}$/.test(s.commit)));
  assert.equal(rowStatus(root, 'a'), 'done');
  assert.equal(rowStatus(root, 'b'), 'done');
  assert.equal(clean(root), '');
  assert.equal(commits(root).length, 3);
  assert.match(commits(root)[0], /^feat\(migration\): b: Second$/);
  assert.ok(g(root, 'show', '--stat', '--format=', 'HEAD~0').includes('roadmap.md'), 'the commit holds the roadmap change');
  assert.ok(g(root, 'show', '--stat', '--format=', 'HEAD~0').includes('src/b.kt'), 'and the code');
  assert.equal(g(remote, 'for-each-ref').trim(), before, 'nothing was pushed');
  assert.ok(OUTCOMES.includes(r.outcome));
  const { md, json } = readReport(root, r);
  assert.match(md, /Nothing was pushed, merged or published/);
  assert.ok(md.includes(r.branch));
  assert.equal(json.outcome, 'done');
  assert.equal(json.nothingPushed, true);
  assert.ok(fs.existsSync(path.join(runDir(root, r), 'iteration-1.json')));
  const it = JSON.parse(fs.readFileSync(path.join(runDir(root, r), 'iteration-1.json'), 'utf8'));
  assert.equal(it.step, 'a');
  assert.equal(it.verification.ok, true);
  assert.ok(it.commit);
});

test('budget: maxIterations, reported tokens, wall clock (injected clock) and the usage-null estimate', async () => {
  const plan = mkPlan(Array.from({ length: 12 }, (_, i) => S(`s${i}`, `Step ${i}`)));
  let root = project(plan, { config: { budgets: { maxIterations: 1 } } });
  let r = await go(root);
  assert.equal(r.outcome, 'budget');
  assert.equal(r.reason, 'budget reached: maxIterations (1)');
  assert.equal(r.iterations, 1);
  assert.equal(rowStatus(root, 's0'), 'done');

  root = project(plan, { config: { budgets: { maxTotalTokens: 100 } } });
  r = await go(root, { agent: worker(async (_r, o) => reply(o.step.id, 'done', { usage: { totalTokens: 150 } })) });
  assert.equal(r.reason, 'budget reached: maxTotalTokens (100)');
  assert.equal(r.iterations, 1);
  assert.equal(r.usage.totalTokens, 150);

  root = project(plan, { config: { budgets: { maxWallClockMinutes: 60 } } });
  let clock = 1_000_000_000_000;
  r = await go(root, { now: () => clock, agent: worker(async (_r, o) => { clock += 61 * 60_000; return reply(o.step.id); }) });
  assert.equal(r.reason, 'budget reached: maxWallClockMinutes (60)');
  assert.equal(r.iterations, 1);

  // usage null: the per-iteration floor (max(1, maxTotalTokens / (maxIterations * 10))) trips the token budget
  root = project(plan, { config: { budgets: { maxTotalTokens: 3, maxIterations: 200 } } });
  r = await go(root, { agent: worker(async (_r, o) => reply(o.step.id, 'done', { usage: null })) });
  assert.equal(r.outcome, 'budget');
  assert.equal(r.reason, 'budget reached: maxTotalTokens (3)');
  assert.equal(r.iterations, 3);
  assert.equal(r.usage.estimated, true);
  // a lying agent that reports zero usage is raised to the floor too
  root = project(plan, { config: { budgets: { maxTotalTokens: 3, maxIterations: 200 } } });
  r = await go(root, { agent: worker(async (_r, o) => reply(o.step.id, 'done', { usage: { totalTokens: 0 } })) });
  assert.equal(r.iterations, 3);
});

test('budgetExit is one small testable function', () => {
  const cfg = { budgets: { maxIterations: 2, maxTotalTokens: 10, maxWallClockMinutes: 1 } };
  assert.equal(budgetExit(cfg, { iterations: 1, tokens: 9, startedMs: 0 }, 59_999), null);
  assert.match(budgetExit(cfg, { iterations: 2, tokens: 0, startedMs: 0 }, 0).reason, /maxIterations/);
  assert.match(budgetExit(cfg, { iterations: 0, tokens: 10, startedMs: 0 }, 0).reason, /maxTotalTokens/);
  assert.match(budgetExit(cfg, { iterations: 0, tokens: 0, startedMs: 0 }, 60_000).reason, /maxWallClockMinutes/);
});

test('an agent that fails twice in a row (failed status, or a missing/invalid status) stops with no-progress', async () => {
  for (const second of [(id) => reply(id, 'failed'), () => ({ ...reply('x'), status: { ok: false, reason: 'no status block' } })]) {
    const root = project();
    const calls = [];
    const r = await go(root, { agent: async (_root, _c, o) => { calls.push(o); return second(o.step.id); } });
    assert.equal(r.outcome, 'no-progress');
    assert.equal(r.reason, REASONS.agentFailedTwice('a'));
    assert.equal(calls.length, 2);
    assert.equal(rowStatus(root, 'a'), 'doing');
    assert.equal(commits(root).length, 1);
  }
});

test('agent exit code non-zero counts as a failure even when a done block was printed', async () => {
  const root = project();
  const r = await go(root, { agent: worker(async (_r, o) => reply(o.step.id, 'done', { exitCode: 3 })) });
  assert.equal(r.outcome, 'no-progress');
  assert.equal(commits(root).length, 1);
});

test('an empty diff after a done claim is no-progress; the step stays doing', async () => {
  const root = project();
  const r = await go(root, { agent: async (_r, _c, o) => reply(o.step.id) });
  assert.equal(r.outcome, 'no-progress');
  assert.equal(r.reason, REASONS.noChange);
  assert.equal(rowStatus(root, 'a'), 'doing');
});

test('blocked and needs-human agent reports stop with needs-human', async () => {
  for (const s of ['blocked', 'needs-human']) {
    const root = project();
    const r = await go(root, { agent: async (_r, _c, o) => reply(o.step.id, s, { status: { ok: true, status: { step: o.step.id, status: s, summary: `need ${FAKE_SECRET} \u0007 # x`, filesChanged: [], verification: '' } } }) });
    assert.equal(r.outcome, 'needs-human');
    assert.equal(r.reason, REASONS.agentReported('a', s));
    assert.ok(!JSON.stringify(r).includes(FAKE_SECRET));
    const { md } = readReport(root, r);
    assert.ok(!md.includes(FAKE_SECRET));
    assert.doesNotMatch(md, /[\u0000-\u0008\u000b-\u001f]/);
  }
});

test('the same error signature again on another step is repeated-error', async () => {
  const plan = mkPlan([S('a', 'A'), S('b', 'B')]);
  const root = project(plan);
  const seq = [false, true, false]; // a fails, a passes after its retry, b fails with the same signature
  let i = 0;
  const verifier = async () => (seq[i++] ? okVerifier() : failVerifier('same')());
  const r = await go(root, { verifier });
  assert.equal(r.outcome, 'repeated-error');
  assert.equal(r.reason, REASONS.repeatedError('b'));
  assert.equal(rowStatus(root, 'a'), 'done');
  assert.equal(rowStatus(root, 'b'), 'doing');
});

test('verification failing twice: one retry with the redacted failure tail, then verification-failed, tree untouched', async () => {
  const root = project();
  const calls = [];
  const r = await go(root, { agent: worker(null, calls), verifier: failVerifier('s', `error: broke ${FAKE_SECRET}\n\u0007bell`) });
  assert.equal(r.outcome, 'verification-failed');
  assert.equal(r.reason, REASONS.verifyFailedTwice('a'));
  assert.equal(calls.length, 2);
  assert.ok(calls[1].brief.includes('error: broke'));
  assert.ok(!calls[1].brief.includes(FAKE_SECRET), 'failure tail is redacted in the retry brief');
  assert.ok(!calls[0].brief.includes('error: broke'));
  assert.equal(rowStatus(root, 'a'), 'doing');
  assert.equal(commits(root).length, 1);
  assert.ok(fs.existsSync(path.join(root, 'src/a.kt')), 'the agent changes stay in the tree');
  assert.match(g(root, 'status', '--porcelain', '--', 'src'), /src/);
  assert.equal(r.steps[0].status, 'doing');
});

test('verification that hangs is killed at the timeout and counts as a failure', async () => {
  const root = project(CHAIN, { config: { verification: { commands: [['node', 'tools/hang.js']], timeoutSeconds: 1 } }, extra: { 'tools/hang.js': 'setInterval(() => {}, 1000);\n' } });
  const t0 = Date.now();
  const r = await go(root, { verifier: undefined });
  assert.equal(r.outcome, 'verification-failed');
  assert.ok(Date.now() - t0 < 40_000);
  assert.equal(rowStatus(root, 'a'), 'doing');
});

// ---------- human gates ----------
test('a gated step is never executed; independent steps run first; its dependents wait', async () => {
  const plan = mkPlan([S('g', 'Decide', { tags: ['decision'] }), S('h', 'After', { dependsOn: ['g'] }), S('i', 'Independent')]);
  const root = project(plan);
  const calls = [];
  const r = await go(root, { agent: worker(null, calls) });
  assert.deepEqual(calls.map((c) => c.step.id), ['i']);
  assert.equal(r.outcome, 'needs-human');
  assert.equal(r.reason, 'steps need a human: g (decision)');
  assert.equal(rowStatus(root, 'g'), 'todo');
  assert.equal(rowStatus(root, 'h'), 'todo');
  assert.deepEqual(r.gated, [{ id: 'g', tags: ['decision'] }]);
  assert.match(readReport(root, r).md, /Waiting for a human/);
});

test('when every remaining step is gated the loop stops before running anything', async () => {
  const plan = mkPlan([S('g', 'Decide', { tags: ['decision'] }), S('x', 'Point of no return', { tags: ['irreversible'] })]);
  const root = project(plan);
  const calls = [];
  const r = await go(root, { agent: worker(null, calls) });
  assert.equal(calls.length, 0);
  assert.equal(r.reason, 'steps need a human: g (decision), x (irreversible)');
  assert.equal(r.iterations, 0);
});

test('a doing step that is gated (hand-edited roadmap) is not run', async () => {
  const plan = mkPlan([S('g', 'Decide', { tags: ['decision'] })]);
  const root = project(plan);
  fs.writeFileSync(path.join(root, '.ai/migration/roadmap.md'), roadmap(root).replace('| todo |', '| doing |'));
  g(root, 'commit', '-qam', 'hand edit');
  const calls = [];
  const r = await go(root, { agent: worker(null, calls) });
  assert.equal(calls.length, 0);
  assert.equal(r.outcome, 'needs-human');
});

// ---------- STOP ----------
test('.ai/STOP before an iteration stops without running the agent', async () => {
  const root = project();
  const calls = [];
  const r = await go(root, { agent: worker(null, calls), say: (m) => { if (m.startsWith('working on')) fs.writeFileSync(path.join(root, '.ai/STOP'), ''); } });
  assert.equal(r.outcome, 'stopped');
  assert.equal(r.reason, REASONS.stopped);
  assert.equal(calls.length, 0);
  assert.equal(rowStatus(root, 'a'), 'todo');
});

test('.ai/STOP appearing during an iteration (file, symlink, directory) stops before any commit', async () => {
  for (const make of [
    (root) => fs.writeFileSync(path.join(root, '.ai/STOP'), 'x'),
    (root) => fs.symlinkSync('/etc/passwd', path.join(root, '.ai/STOP')),
    (root) => fs.mkdirSync(path.join(root, '.ai/STOP')),
  ]) {
    const root = project();
    const r = await go(root, { agent: worker(async (rt) => { make(rt); }) });
    assert.equal(r.outcome, 'stopped');
    assert.equal(commits(root).length, 1, 'no commit');
    assert.equal(rowStatus(root, 'a'), 'doing');
    assert.equal(stopPresent(root), true);
    assert.equal(fs.readFileSync(path.join(root, 'src/a.kt'), 'utf8').length > 0, true);
  }
});

test('.ai/STOP appearing between verification and the commit stops without committing', async () => {
  const root = project();
  const verifier = async () => { fs.writeFileSync(path.join(root, '.ai/STOP'), ''); return okVerifier(); };
  const r = await go(root, { verifier });
  assert.equal(r.outcome, 'stopped');
  assert.equal(commits(root).length, 1);
  assert.equal(rowStatus(root, 'a'), 'doing');
});

// ---------- tampering ----------
test('an agent that edits protected files mid-step is tampered: nothing is committed', async () => {
  const cases = {
    config: (root) => fs.appendFileSync(path.join(root, '.ai/run.config.json'), ' '),
    'config created': (root) => fs.writeFileSync(path.join(root, '.ai/run.config.json'), '{"schemaVersion":1}'),
    roadmap: (root) => fs.writeFileSync(path.join(root, '.ai/migration/roadmap.md'), roadmap(root).replace('| todo |', '| done |')),
    plan: (root) => fs.appendFileSync(path.join(root, '.ai/migration/plan.json'), ' '),
    'git config': (root) => fs.appendFileSync(path.join(root, '.git/config'), '[alias]\n\tx = status\n'),
    hook: (root) => { fs.mkdirSync(path.join(root, '.git/hooks'), { recursive: true }); fs.writeFileSync(path.join(root, '.git/hooks/post-commit'), '#!/bin/sh\n'); },
    'own commit': (root) => { g(root, 'add', '-A'); g(root, 'commit', '-q', '-m', 'sneaky'); },
    exclude: (root) => fs.appendFileSync(path.join(root, '.git/info/exclude'), 'src/\n'),
  };
  for (const [name, edit] of Object.entries(cases)) {
    const root = project();
    const before = commits(root).length;
    const r = await go(root, { agent: worker(async (rt) => { edit(rt); }) });
    assert.equal(r.outcome, 'tampered', name);
    assert.match(r.reason, /^the agent changed protected files \(.+\); nothing was committed$/, name);
    assert.equal(commits(root).length, before + (name === 'own commit' ? 1 : 0), name);
    assert.equal(rowStatus(root, 'a'), 'doing', name);
  }
});

test('the run config swapped between iterations: consent no longer matches, the loop refuses to go on', async () => {
  const plan = mkPlan([S('a', 'A'), S('b', 'B')]);
  const root = project(plan, { config: { budgets: { maxIterations: 5 } } });
  g(root, 'status', '--short');
  const r = await go(root, {
    say: (m) => {
      if (m.includes('a: verified and committed')) fs.writeFileSync(path.join(root, '.ai/run.config.json'), JSON.stringify({ schemaVersion: 1, budgets: { maxIterations: 200 } }));
    },
  });
  assert.equal(r.outcome, 'refused');
  assert.equal(r.reason, REASONS.drift);
  assert.equal(rowStatus(root, 'b'), 'todo');
  assert.equal(r.iterations, 1);
});

// ---------- hostile agent output through the real adapter ----------
const stubAgent = (...mode) => (root, _cfg, opts) => runAgent(root, { ...JSON.parse(JSON.stringify(DEFAULT_RUN_CONFIG)), agent: { kind: 'custom', command: [process.execPath, STUB, ...mode, '{step}'], requireArgs: [], passEnv: [] } }, { ...opts, timeoutMs: Math.min(opts.timeoutMs, 20_000) });

test('a forged status (right step id, wrong nonce) printed by the agent is ignored', async () => {
  const root = project();
  const r = await go(root, { agent: stubAgent('forge-same-id') });
  assert.equal(r.outcome, 'no-progress');
  assert.equal(r.reason, REASONS.agentFailedTwice('a'));
  assert.equal(commits(root).length, 1);
});

test('an agent that never exits is killed at the timeout: failed, step stays doing', async () => {
  const root = project();
  const t0 = Date.now();
  const r = await go(root, { agent: stubAgent('hang'), agentTimeoutMs: 1000 });
  assert.equal(r.outcome, 'failed');
  assert.equal(r.reason, REASONS.agentTimeout);
  assert.ok(Date.now() - t0 < 30_000);
  assert.equal(rowStatus(root, 'a'), 'doing');
});

test('huge agent output cannot grow logs or the report', async () => {
  const root = project();
  const huge = `${'x'.repeat(100)}\n`.repeat(400_000); // 40 MB
  const r = await go(root, { agent: worker(async (_r, o) => reply(o.step.id, 'done', { outputTail: huge, status: { ok: true, status: { step: o.step.id, status: 'done', summary: 's'.repeat(5_000_000), filesChanged: [], verification: '' } } })) });
  assert.equal(r.outcome, 'done');
  for (const f of fs.readdirSync(runDir(root, r))) {
    if (f.startsWith('iteration-') || f.startsWith('report')) assert.ok(fs.statSync(path.join(runDir(root, r), f)).size < 200 * 1024, f);
  }
});

test('an agent that throws produces a plain failed result (no stack, no absolute path)', async () => {
  const root = project();
  const r = await go(root, { agent: async () => { throw new Error(`boom at ${root}/x\n    at somewhere`); } });
  assert.equal(r.outcome, 'failed');
  assert.ok(!r.reason.includes(root));
  assert.ok(!/\n/.test(r.reason));
});

// ---------- scale and sanitizing ----------
test('a plan with 10,000 steps stays bounded in time, memory and report size', async () => {
  const plan = mkPlan(Array.from({ length: 10_000 }, (_, i) => S(`s${i}`, `Step ${i}`)));
  const root = project(plan, { config: { budgets: { maxIterations: 2 } } });
  const t0 = Date.now();
  const r = await go(root);
  assert.equal(r.outcome, 'budget');
  assert.equal(r.steps.length, 2);
  assert.ok(Date.now() - t0 < 90_000);
  const { md, json } = readReport(root, r);
  assert.ok(md.length < 64 * 1024);
  assert.equal(json.remaining.todo, 9_998);
});

test('hostile step titles cannot forge markup, tables or control characters in the report', async () => {
  const plan = mkPlan([S('a', '# Pwned | `x` | done |\n## <script>alert(1)</script> [irreversible] \u0007‮ [link](http://x)\r\n> quote')]);
  const root = project(plan);
  const r = await go(root);
  assert.equal(r.outcome, 'done');
  const { md, json } = readReport(root, r);
  assert.doesNotMatch(md, /[\u0000-\u0008\u000b-\u001f‮]/);
  assert.ok(!md.split('\n').some((l) => /^#{1,6} /.test(l) && !['# Run report', '## Steps in this run', '## How to resume', '## Warnings', '## Waiting for a human', '## What the agent said (untrusted text, shortened)'].includes(l)));
  assert.ok(!md.includes('<script>'));
  assert.ok(!/(^|[^\\])\]\(/.test(md), 'no unescaped link syntax');
  const row = md.split('\n').find((l) => l.startsWith('| `a`'));
  assert.equal(row.replace(/\\\|/g, '').split('|').length, 8, 'the table row keeps its 6 cells');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(JSON.stringify(json)));
});

test('reports, logs and results hold no secrets', async () => {
  const root = project();
  const secretAgent = worker(async (_r, o) => reply(o.step.id, 'done', { outputTail: `token ${FAKE_SECRET}\nAuthorization: Bearer abcdef0123456789abcdef0123456789`, status: { ok: true, status: { step: o.step.id, status: 'done', summary: `used ${FAKE_SECRET}`, filesChanged: [], verification: '' } } }));
  const r = await go(root, { agent: secretAgent, verifier: async () => ({ ok: true, results: [{ argv: ['./gradlew', `-Pkey=${FAKE_SECRET}`], exitCode: 0, tail: `built ${FAKE_SECRET}`, signature: '' }] }) });
  assert.equal(r.outcome, 'done');
  for (const f of fs.readdirSync(runDir(root, r))) assert.ok(!fs.readFileSync(path.join(runDir(root, r), f), 'utf8').includes(FAKE_SECRET), f);
  assert.ok(!JSON.stringify(r).includes(FAKE_SECRET));
});

test('roadmap edits by the runner only touch status cells', async () => {
  const plan = mkPlan([S('a', 'A | pipe'), S('b', 'B', { dependsOn: ['a'] })]);
  const root = project(plan);
  const before = roadmap(root);
  const r = await go(root);
  assert.equal(r.outcome, 'done');
  assert.equal(roadmap(root), before.split('\n').map((l) => (l.startsWith('| `a`') || l.startsWith('| `b`') ? l.replace(/\| todo \|$/, '| done |') : l)).join('\n'));
});

// ---------- refusals ----------
test('refuses on a default branch, with a declined confirmation, or with a broken plan; nothing is written', async () => {
  let root = project();
  g(root, 'switch', '-q', 'main');
  let r = await go(root);
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /default branch/);
  assert.equal(r.reportPath, null);
  assert.equal(fs.existsSync(path.join(root, '.ai/runs')), false);

  root = project();
  r = await go(root, { confirm: async () => false });
  assert.equal(r.outcome, 'refused');
  assert.equal(r.reason, REASONS.declined);
  assert.equal(g(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature');

  root = project();
  fs.writeFileSync(path.join(root, '.ai/migration/plan.json'), '{broken');
  g(root, 'commit', '-qam', 'break');
  r = await go(root);
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /^the plan cannot be loaded/);
  assert.ok(!r.reason.includes(root));
});

// ---------- lock ----------
test('two loops on one repository: the second is refused with a plain message', async () => {
  const root = project();
  let release;
  const gate = new Promise((res) => { release = res; });
  let entered;
  const inside = new Promise((res) => { entered = res; });
  const first = go(root, { agent: worker(async () => { entered(); await gate; }) });
  await inside;
  const second = await go(root);
  assert.equal(second.outcome, 'refused');
  assert.match(second.reason, /^another run is active in this repository \(process \d+\); wait for it to finish$/);
  assert.equal(second.reportPath, null);
  release();
  assert.equal((await first).outcome, 'done');
  // the lock is gone afterwards: a third run works (resumes: nothing left)
  assert.equal((await go(root)).outcome, 'done');
});

test('a stale lock (its process is gone) is taken over; a live pid is respected', async () => {
  const root = project();
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((res) => dead.on('exit', res));
  const dir = path.join(root, '.git/android-architect');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ schemaVersion: 1, pid: dead.pid, token: 'old' }));
  const lock = await acquireLock(rungit, root);
  assert.equal(lock.holds(), true);
  lock.release();
  assert.equal(fs.existsSync(path.join(dir, 'run.lock')), false);
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ schemaVersion: 1, pid: process.pid, token: 'live' }));
  await assert.rejects(() => acquireLock(rungit, root), /another run is active/);
  fs.symlinkSync('/etc/passwd', path.join(dir, 'x'));
  fs.rmSync(path.join(dir, 'run.lock'));
  fs.symlinkSync('/nonexistent-target', path.join(dir, 'run.lock'));
  await assert.rejects(() => acquireLock(rungit, root), /not usable|cannot create/);
});

// ---------- resume ----------
test('resume: a doing step whose commit is on the run branch is only marked done (the agent is not run)', async () => {
  const root = project();
  startRunBranch(root, { branchPrefix: 'android-architect/run', now: Date.UTC(2026, 10, 20) });
  setStatus(root, 'a', 'doing', 'todo');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.kt'), '// a\n');
  assert.ok(commitStep(root, { id: 'a', title: 'First' }, 'First')); // simulated crash: committed while the row still says doing
  assert.equal(rowStatus(root, 'a'), 'doing');
  const calls = [];
  const r = await go(root, { agent: worker(null, calls) });
  assert.equal(r.outcome, 'done');
  assert.equal(r.resumed, true);
  assert.deepEqual(calls.map((c) => c.step.id), ['b'], 'only b ran');
  assert.equal(rowStatus(root, 'a'), 'done');
  assert.ok(r.steps.find((s) => s.id === 'a').result.startsWith('resumed'));
});

test('resume: a doing step without a commit is run again, never skipped', async () => {
  const root = project();
  startRunBranch(root, { branchPrefix: 'android-architect/run', now: Date.UTC(2026, 10, 20) });
  setStatus(root, 'a', 'doing', 'todo'); // an earlier run stopped here (row uncommitted)
  const calls = [];
  const r = await go(root, { agent: worker(null, calls) });
  assert.equal(r.outcome, 'done');
  assert.deepEqual(calls.map((c) => c.step.id), ['a', 'b']);
});

// ---------- interruption ----------
test('an AbortSignal during the agent stops the loop as interrupted: step doing, report written', async () => {
  const root = project();
  const ac = new AbortController();
  const r = await go(root, { signal: ac.signal, interruptGraceMs: 100, agent: async () => { setTimeout(() => ac.abort(), 50); return new Promise(() => {}); } });
  assert.equal(r.outcome, 'interrupted');
  assert.equal(r.reason, REASONS.interrupted('abort'));
  assert.equal(rowStatus(root, 'a'), 'doing');
  assert.equal(readReport(root, r).json.outcome, 'interrupted');
});

for (const SIG of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) test(`${SIG} in the middle of a real agent: cleanup runs, step left doing, report says interrupted`, async () => {
  const root = project();
  const child = spawn(process.execPath, [CHILD, root, STUB], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let ready;
  const isReady = new Promise((res) => { ready = res; });
  child.stdout.on('data', (c) => { out += c; if (out.includes('READY')) ready(); });
  let guard;
  await Promise.race([isReady, new Promise((_, rej) => { guard = setTimeout(() => rej(new Error('child did not start the agent')), 30_000); })]);
  clearTimeout(guard); // an uncleared timer kept the whole test process alive for 30 s
  child.kill(SIG);
  const code = await new Promise((res) => child.on('exit', res));
  assert.equal(code, 0);
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  const res = JSON.parse(line.slice(7));
  assert.equal(res.outcome, 'interrupted');
  assert.ok(res.reason.includes(SIG));
  assert.ok(fs.existsSync(path.join(root, res.reportPath)));
  assert.equal(rowStatus(root, 'a'), 'doing');
  assert.equal(fs.existsSync(path.join(root, '.git/android-architect/run.lock')), false, 'the lock is released');
});

test('a symlinked .ai/runs is never written through: the run fails plainly and nothing lands outside', async () => {
  const root = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-loop-out-'));
  tmps.push(outside);
  fs.symlinkSync(outside, path.join(root, '.ai/runs'));
  const r = await go(root);
  assert.equal(r.outcome, 'failed'); // the guarded writer refuses any symlink under .ai, so even the roadmap edit stops
  assert.match(r.reason, /refusing to write through a symlink/);
  assert.ok(!r.reason.includes(root));
  assert.equal(r.reportPath, null);
  assert.match(r.reportError, /^the report could not be written/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a roadmap full of doing rows cannot keep the loop spinning', async () => {
  const plan = mkPlan(Array.from({ length: 300 }, (_, i) => S(`s${i}`, `Step ${i}`)));
  const root = project(plan, { config: { budgets: { maxIterations: 3 } } });
  fs.writeFileSync(path.join(root, '.ai/migration/roadmap.md'), roadmap(root).replaceAll('| todo |', '| doing |'));
  g(root, 'commit', '-qam', 'all doing');
  const r = await go(root);
  assert.equal(r.outcome, 'budget');
  assert.equal(r.iterations, 3);
});

test('a second signal while the loop is stopping exits at once (default handling)', async () => {
  const root = project();
  const child = spawn(process.execPath, [CHILD, root, STUB, 'busy'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const waitFor = (word) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no ${word}`)), 30_000);
    const check = () => { if (out.includes(word)) { clearTimeout(t); child.stdout.off('data', onData); res(); } };
    const onData = (c) => { out += c; check(); };
    child.stdout.on('data', onData);
    check();
  });
  await waitFor('READY');
  child.kill('SIGINT');
  await waitFor('BUSY'); // the child is waiting for its (never settling) agent
  child.kill('SIGINT');
  const [code, sig] = await new Promise((res) => child.on('exit', (c, sg) => res([c, sg])));
  assert.equal(sig, 'SIGINT');
  assert.equal(code, null);
  assert.ok(!out.includes('RESULT'));
  assert.equal(rowStatus(root, 'a'), 'doing');
});

// ---------- build-code gate (ruling 15) ----------
const GRADLEW = { gradlew: '#!/bin/sh\necho build\n' };
const evilGradlew = (root) => fs.writeFileSync(path.join(root, 'gradlew'), '#!/bin/sh\ntouch pwned\n');

test('build files changed by the agent stop the loop before verification; approval by exact hash lets it go on', async () => {
  const root = project(CHAIN, { extra: GRADLEW });
  let verified = 0;
  const verifier = async () => { verified++; return okVerifier(); };
  const r = await go(root, { agent: worker(async (rt) => { evilGradlew(rt); }), verifier });
  assert.equal(r.outcome, 'needs-human');
  assert.match(r.reason, /^build files changed: 1 — review, then rerun with --approve-build-changes [0-9a-f]{64}$/);
  assert.equal(verified, 0, 'build code never ran');
  assert.equal(rowStatus(root, 'a'), 'doing');
  assert.equal(commits(root).length, 1);
  assert.deepEqual(r.buildFiles, ['gradlew']);
  const { md, json } = readReport(root, r);
  assert.match(md, /Build files changed by the agent/);
  assert.deepEqual(json.buildFiles, ['gradlew']);
  const hash = r.reason.split(' ').pop();

  const again = project(CHAIN, { extra: GRADLEW });
  const ok = await go(again, { agent: worker(async (rt) => { evilGradlew(rt); }), approvedBuildChanges: [hash] });
  assert.equal(ok.outcome, 'done');
  // later edits invalidate the approval
  const third = project(CHAIN, { extra: GRADLEW });
  const bad = await go(third, { agent: worker(async (rt) => { fs.writeFileSync(path.join(rt, 'gradlew'), '#!/bin/sh\ntouch other\n'); }), approvedBuildChanges: [hash] });
  assert.equal(bad.outcome, 'needs-human');
});

test('an untracked or nested build script is gated too', async () => {
  const root = project();
  const r = await go(root, { agent: worker(async (rt) => { fs.mkdirSync(path.join(rt, 'feature/x'), { recursive: true }); fs.writeFileSync(path.join(rt, 'feature/x/build.gradle.kts'), 'x'); }) });
  assert.equal(r.outcome, 'needs-human');
  assert.match(r.reason, /build files changed: 1/);
});

// ---------- STOP polling (ruling 16) ----------
test('.ai/STOP appearing while the agent runs kills it at once (polled)', async () => {
  const root = project();
  setTimeout(() => fs.writeFileSync(path.join(root, '.ai/STOP'), ''), 600);
  const t0 = Date.now();
  const r = await go(root, { agent: stubAgent('hang'), agentTimeoutMs: 25_000, stopPollMs: 100 });
  assert.equal(r.outcome, 'stopped');
  assert.ok(Date.now() - t0 < 10_000, 'stopped long before the agent timeout');
  assert.equal(rowStatus(root, 'a'), 'doing');
});

test('.ai/STOP appearing while verification runs kills it at once (polled)', async () => {
  const root = project();
  let started;
  const verifier = () => new Promise(() => { started = true; setTimeout(() => fs.writeFileSync(path.join(root, '.ai/STOP'), ''), 300); });
  const r = await go(root, { verifier, stopPollMs: 100 });
  assert.ok(started);
  assert.equal(r.outcome, 'stopped');
  assert.equal(commits(root).length, 1);
});

// ---------- git index and ignore rules (ruling 17) ----------
test('agent empties .gitignore and force-adds local.properties: tampered, nothing committed', async () => {
  const root = project(CHAIN, { extra: { '.gitignore': 'local.properties\n' } });
  const r = await go(root, { agent: worker(async (rt) => {
    fs.writeFileSync(path.join(rt, 'local.properties'), `sdk.dir=/x\nkey=${FAKE_SECRET}\n`);
    fs.writeFileSync(path.join(rt, '.gitignore'), '');
    g(rt, 'add', '-f', 'local.properties');
  }) });
  assert.equal(r.outcome, 'tampered');
  assert.equal(commits(root).length, 1);
});

test('files the agent force-staged are unstaged: only the runner add -A decides what is committed', async () => {
  const root = project(CHAIN, { extra: { '.gitignore': 'local.properties\n' } });
  const r = await go(root, { agent: worker(async (rt, o) => {
    if (o.step.id !== 'a') return;
    fs.writeFileSync(path.join(rt, 'local.properties'), `key=${FAKE_SECRET}\n`);
    g(rt, 'add', '-f', 'local.properties');
  }) });
  assert.equal(r.outcome, 'done');
  assert.ok(!g(root, 'ls-tree', '-r', '--name-only', 'HEAD').includes('local.properties'));
  assert.ok(!g(root, 'log', '-p', '--all').includes(FAKE_SECRET));
});

test('secret-looking and runner-state files in the staged set: needs-human, nothing committed, step back to doing', async () => {
  for (const rel of ['keystore.properties', '.env.production', 'app/release.jks', 'google-services.json', '.ai/notes.md', 'deploy/id_rsa']) {
    const root = project();
    const r = await go(root, { agent: worker(async (rt) => { fs.mkdirSync(path.join(rt, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(rt, rel), 'x'); }) });
    assert.equal(r.outcome, 'needs-human', rel);
    assert.match(r.reason, /^the commit was refused: refusing to commit 1 file\(s\) that look like secrets or runner state/, rel);
    assert.equal(commits(root).length, 1, rel);
    assert.equal(rowStatus(root, 'a'), 'doing', rel);
    assert.equal(g(root, 'diff', '--cached', '--name-only').trim(), '', 'index left clean');
  }
});

test('an agent change that only touches .ai/migration bookkeeping does not count as progress', async () => {
  const root = project();
  const r = await go(root, { agent: async (rt, _c, o) => { fs.writeFileSync(path.join(rt, '.ai/migration/notes.md'), 'x'); return reply(o.step.id); } });
  assert.equal(r.outcome, 'no-progress');
});

// ---------- verification deadline, resume, lock (minors) ----------
test('all verification commands share one deadline', async () => {
  const root = project(CHAIN, { extra: { 'tools/sleep.js': 'setTimeout(() => {}, 800);\n' } });
  const config = { verification: { commands: [['node', 'tools/sleep.js'], ['node', 'tools/sleep.js']], timeoutSeconds: 60 } };
  const { runVerification } = await import('../skill/scripts/lib/runverify.js');
  const r = await runVerification(root, config, { totalMs: 1200 });
  assert.equal(r.ok, false);
  // the second command only gets what is left: it times out, or (slow machine) the budget is already gone
  assert.ok(r.results.at(-1)?.timedOut === true || /time budget/.test(r.reason ?? ''), 'the shared deadline, not 60 s per command, ended it');
});

test('resume matches the cut subject of a long step id, but not when another step shares the cut prefix', async () => {
  const long = `x${'y'.repeat(79)}`;
  for (const [ids, expectRun] of [[[long, 'z'], ['z']], [[long, `${long}-2`], [`${long}`, `${long}-2`]]]) {
    const plan = mkPlan(ids.map((id) => S(id, 'T', {})));
    const root = project(plan);
    startRunBranch(root, { branchPrefix: 'android-architect/run', now: Date.UTC(2026, 10, 20) });
    setStatus(root, long, 'doing', 'todo');
    fs.writeFileSync(path.join(root, 'a.kt'), 'x');
    assert.ok(commitStep(root, { id: long, title: 'T' }, 'T'));
    const calls = [];
    const r = await go(root, { agent: worker(null, calls) });
    assert.equal(r.outcome, 'done');
    assert.deepEqual(calls.map((c) => c.step.id), expectRun);
  }
});

// ---------- verify-only resume (ruling 19) ----------
/** Runs the gate once (agent edits gradlew) and returns { root, hash } with the tree left dirty on the run branch. */
async function gated(extraCfg = {}) {
  const root = project(CHAIN, { extra: GRADLEW, ...extraCfg });
  const r = await go(root, { agent: worker(async (rt) => { evilGradlew(rt); }) });
  assert.equal(r.outcome, 'needs-human');
  return { root, hash: r.reason.split(' ').pop(), branch: r.branch };
}

test('gate -> approve the hash -> rerun verifies the existing changes and commits without running the agent for that step', async () => {
  const { root, hash } = await gated();
  const calls = [];
  const r = await go(root, { agent: worker(null, calls), approvedBuildChanges: [hash] });
  assert.equal(r.outcome, 'done');
  assert.equal(r.resumed, true);
  assert.deepEqual(calls.map((c) => c.step.id), ['b'], 'the agent ran only for b');
  assert.equal(rowStatus(root, 'a'), 'done');
  assert.ok(g(root, 'ls-tree', '-r', '--name-only', 'HEAD~1').split('\n').includes('gradlew'));
  assert.match(g(root, 'log', '--format=%s', '-n', '2'), /feat\(migration\): a: First/);
});

test('a wrong or stale approval hash is refused plainly: no agent, no change', async () => {
  const { root } = await gated();
  const before = g(root, 'status', '--porcelain', '--', '.', ':(exclude).ai/runs');
  const calls = [];
  const r = await go(root, { agent: worker(null, calls), approvedBuildChanges: ['0'.repeat(64)] });
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /approved build-change hash does not match/);
  assert.equal(calls.length, 0);
  assert.equal(g(root, 'status', '--porcelain', '--', '.', ':(exclude).ai/runs'), before);
});

test('a build file edited after the approval gates again', async () => {
  const { root, hash } = await gated();
  fs.writeFileSync(path.join(root, 'gradlew'), '#!/bin/sh\ntouch later\n');
  const calls = [];
  const r = await go(root, { agent: worker(null, calls), approvedBuildChanges: [hash] });
  assert.equal(r.outcome, 'refused');
  assert.equal(calls.length, 0);
});

test('a dirty tree without any approval is still refused', async () => {
  const { root } = await gated();
  const r = await go(root);
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /not clean/);
});

test('an approval never relaxes the default-branch refusal', async () => {
  const { root, hash } = await gated();
  g(root, 'stash', '-u', '-q');
  g(root, 'switch', '-q', 'main');
  g(root, 'stash', 'pop', '-q');
  const r = await go(root, { approvedBuildChanges: [hash] });
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /default branch/);
});

test('verify-only resume: a secret-looking file in the tree -> needs-human; STOP present -> stopped; protected file edited -> refused', async () => {
  let t = await gated();
  fs.writeFileSync(path.join(t.root, 'keystore.properties'), 'x');
  let calls = [];
  let r = await go(t.root, { agent: worker(null, calls), approvedBuildChanges: [t.hash] });
  assert.equal(r.outcome, 'needs-human');
  assert.match(r.reason, /look like secrets/);
  assert.equal(calls.length, 0);

  t = await gated();
  fs.writeFileSync(path.join(t.root, '.ai/STOP'), '');
  r = await go(t.root, { agent: worker(null, calls), approvedBuildChanges: [t.hash] });
  assert.equal(r.outcome, 'stopped');
  assert.equal(calls.length, 0);

  t = await gated();
  fs.writeFileSync(path.join(t.root, '.gitignore'), 'x\n');
  r = await go(t.root, { agent: worker(null, calls), approvedBuildChanges: [t.hash] });
  assert.equal(r.outcome, 'refused');
  assert.equal(calls.length, 0);
});

// ---------- round 3 ----------
test('a second synthetic abort signal does not crash; SIGINT then options.signal abort ends cleanly', async () => {
  const root = project();
  const ac = new AbortController();
  const r = await go(root, { signal: ac.signal, interruptGraceMs: 300, agent: async () => { setTimeout(() => process.emit('SIGINT'), 20); setTimeout(() => ac.abort(), 100); return new Promise(() => {}); } });
  assert.equal(r.outcome, 'interrupted');
  assert.equal(r.reason, REASONS.interrupted('SIGINT'));
});

test('ignored build code written by the agent (build/x.sh, node_modules/.bin/x) gates before `npm test` verification', async () => {
  for (const rel of ['build/x.sh', 'node_modules/.bin/x']) {
    const root = project(CHAIN, { config: { verification: { commands: [['npm', 'test']] } }, extra: { '.gitignore': 'build/\nnode_modules/\n', 'package.json': '{"scripts":{"test":"x"}}' } });
    let verified = 0;
    const r = await go(root, { verifier: async () => { verified++; return okVerifier(); }, agent: worker(async (rt) => { fs.mkdirSync(path.dirname(path.join(rt, rel)), { recursive: true }); fs.writeFileSync(path.join(rt, rel), 'evil'); }) });
    assert.equal(r.outcome, 'needs-human', rel);
    assert.match(r.reason, /^build files changed: 1/, rel);
    assert.equal(verified, 0);
    assert.deepEqual(r.buildFiles, [rel]);
  }
});

test('build-logic and includeBuild sources written by the agent gate', async () => {
  const root = project(CHAIN, { extra: { 'settings.gradle.kts': 'includeBuild("conv")\n', 'conv/a.kt': 'a' } });
  const r = await go(root, { agent: worker(async (rt) => { fs.writeFileSync(path.join(rt, 'conv/b.kt'), 'evil'); fs.mkdirSync(path.join(rt, 'build-logic'), { recursive: true }); fs.writeFileSync(path.join(rt, 'build-logic/c.kt'), 'evil'); }) });
  assert.equal(r.outcome, 'needs-human');
  assert.match(r.reason, /build files changed: 2/);
});

test('credential names (extended list) and credential content in staged files: needs-human, path only, index clean', async () => {
  for (const rel of ['credentials.json', 'service-account-prod.json', 'AuthKey.p8', 'cert.pfx', 'secring.gpg', 'id_ed25519', 'id_ecdsa.pub', '.netrc', '.aws/credentials', 'vault.kdbx']) {
    const root = project();
    const r = await go(root, { agent: worker(async (rt) => { fs.mkdirSync(path.join(rt, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(rt, rel), 'x'); }) });
    assert.equal(r.outcome, 'needs-human', rel);
    assert.equal(g(root, 'diff', '--cached', '--name-only').trim(), '');
  }
  const contents = { 'src/Keys.kt': `val k = "${FAKE_SECRET}"\n`, 'src/pem.txt': '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----\n', 'src/h.txt': 'Authorization: Bearer abcdef0123456789abcdef0123456789\n', 'app/build.txt': 'storePassword "hunter2hunter2"\n' };
  for (const [rel, text] of Object.entries(contents)) {
    const root = project();
    const r = await go(root, { agent: worker(async (rt) => { fs.mkdirSync(path.join(rt, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(rt, rel), text); }) });
    assert.equal(r.outcome, 'needs-human', rel);
    assert.match(r.reason, /whose content looks like credentials/);
    assert.ok(r.reason.includes(path.basename(rel)));
    assert.ok(!JSON.stringify(r).includes(FAKE_SECRET) && !r.reason.includes('hunter2'));
    assert.equal(g(root, 'diff', '--cached', '--name-only').trim(), '');
    assert.equal(commits(root).length, 1);
  }
  // binary files and ordinary text pass
  const root = project();
  const ok = await go(root, { agent: worker(async (rt) => { fs.writeFileSync(path.join(rt, 'blob.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(FAKE_SECRET)])); fs.writeFileSync(path.join(rt, 'notes.txt'), 'password handling is described here\n'); }) });
  assert.equal(ok.outcome, 'done');
});

test('verify-only resume: a step whose commit already exists is refused plainly; changed tags in the dirty roadmap are refused', async () => {
  const t = await gated();
  // simulate: the doing step already has its commit on the run branch while approved changes sit in the tree
  const stash = g(t.root, 'stash', '-u', '-q');
  void stash;
  g(t.root, 'stash', 'pop', '-q');
  fs.mkdirSync(path.join(t.root, 'src'), { recursive: true });
  g(t.root, 'add', 'src');
  const commitNow = () => g(t.root, 'commit', '-q', '--allow-empty', '-m', 'feat(migration): a: First');
  commitNow();
  const calls = [];
  const r = await go(t.root, { agent: worker(null, calls), approvedBuildChanges: [t.hash] });
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /already has its commit on the run branch/);
  assert.equal(calls.length, 0);

  const u = await gated();
  const rm = fs.readFileSync(path.join(u.root, '.ai/migration/roadmap.md'), 'utf8');
  fs.writeFileSync(path.join(u.root, '.ai/migration/roadmap.md'), rm.replace('| `b` | Second', '| `b` | Second [decision]'));
  const r2 = await go(u.root, { agent: worker(null, []), approvedBuildChanges: [u.hash] });
  assert.equal(r2.outcome, 'refused');
  assert.match(r2.reason, /tags of any step/);
});

test('an includeBuild the gate cannot read statically stops the loop (needs-human, plain), nothing verified', async () => {
  const root = project();
  let verified = 0;
  const r = await go(root, { verifier: async () => { verified++; return okVerifier(); }, agent: worker(async (rt) => { fs.writeFileSync(path.join(rt, 'settings.gradle'), 'def p = "x"\nincludeBuild(p)\n'); }) });
  assert.equal(r.outcome, 'needs-human');
  assert.match(r.reason, /includeBuild in a form that cannot be read statically/);
  assert.equal(verified, 0);
  assert.ok(!r.reason.includes(root));
});

test('an agent timeout at wall-clock budget expiry is the budget (exit 6 class), a plain timeout stays failed', async () => {
  const timedOutReply = (opts) => reply(opts.step.id, 'done', { timedOut: true, exitCode: null, signal: 'SIGKILL', status: { ok: false, reason: 'timed out' } });
  let t = Date.parse('2026-01-01T00:00:00Z');
  const root = project();
  const expired = await go(root, { now: () => t, agent: async (_r, _c, opts) => { t += 121 * 60_000; return timedOutReply(opts); } });
  assert.equal(expired.outcome, 'budget');
  assert.equal(expired.reason, REASONS.budget('maxWallClockMinutes', DEFAULT_RUN_CONFIG.budgets.maxWallClockMinutes));
  t = Date.parse('2026-01-01T00:00:00Z');
  const root2 = project();
  const plain = await go(root2, { now: () => t, agent: async (_r, _c, opts) => { t += 5 * 60_000; return timedOutReply(opts); } });
  assert.equal(plain.outcome, 'failed');
  assert.equal(plain.reason, REASONS.agentTimeout);
});
