import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderRoadmap } from '../skill/scripts/lib/migplan.js';
import { OUTCOMES } from '../skill/scripts/lib/runloop.js';
import { NO_RESTRICTIONS_WARNING } from '../skill/scripts/lib/agent.js';
import { killLiveGroups } from '../skill/scripts/lib/runverify.js';
import { main, parseArgs, EXIT, OUTCOME_EXIT, BOOLEAN_FLAGS, VALUE_FLAGS, USAGE } from '../skill/scripts/run.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_JS = path.join(ROOT, 'skill/scripts/run.js');
const CLI = path.join(ROOT, 'bin/cli.js');
const tmps = [];
after(() => {
  killLiveGroups();
  tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
const FAKE_SECRET = 'sk-ant-FAKEFAKEFAKE0123456789abcdefghij';
const HASH = 'a'.repeat(64);
const LEAK = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const S = (id, title, extra = {}) => ({ id, title, track: 'enabling', dimension: 'ui', from: 'x', to: 'y', dependsOn: [], tags: [], verification: [], rollback: 'revert', evidence: [], ...extra });
const mkPlan = (steps) => ({ schemaVersion: 1, steps, tracks: { enabling: steps.map((s) => s.id), data: [], features: [] }, notes: [] });
const CHAIN = mkPlan([S('a', 'First'), S('b', 'Second', { dependsOn: ['a'] }), S('c', 'Gated', { tags: ['decision'] })]);

function project(plan = CHAIN, { config = null, gradle = true, branch = 'feature' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-runcli-')));
  tmps.push(root);
  g(root, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, '.ai/migration'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ai/migration/plan.json'), JSON.stringify(plan));
  fs.writeFileSync(path.join(root, '.ai/migration/roadmap.md'), renderRoadmap(plan));
  if (config) fs.writeFileSync(path.join(root, '.ai/run.config.json'), JSON.stringify({ schemaVersion: 1, ...config }));
  if (gradle) fs.writeFileSync(path.join(root, 'settings.gradle.kts'), '// t\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# t\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'init');
  if (branch) g(root, 'switch', '-q', '-c', branch);
  return root;
}
const CONFIG = { agent: { kind: 'claude', command: ['claude'], passEnv: ['ANTHROPIC_API_KEY'] }, branchPrefix: 'aa/run' };

/** Runs main in-process with captured output. */
async function run(argv, { root, interactive = false, answers = [], runLoop, runOptions, env = {} } = {}) {
  const out = [];
  const err = [];
  const asked = [];
  const io = {
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) },
    cwd: root,
    interactive,
    ask: async (prompt) => {
      asked.push(prompt);
      return answers.shift() ?? null;
    },
    runLoop,
    runOptions,
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const code = await main(argv, io);
    return { code, out: out.join(''), err: err.join(''), all: out.join('') + err.join(''), asked };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const noLeaks = (text, root) => {
  assert.ok(!text.includes(os.tmpdir()), `absolute path in output: ${text.slice(0, 300)}`);
  if (root) assert.ok(!text.includes(root));
  assert.doesNotMatch(text, /\n\s+at \S+ \(|node:internal|\.js:\d+:\d+/);
};
const fakeResult = (over = {}) => ({
  outcome: 'done', reason: 'all roadmap steps are done', steps: [{ id: 'a', title: 'First', status: 'done', result: 'verified and committed', iterations: 1, commit: 'abcdef1', summary: 'did it', diffFiles: ['src/a.kt'] }],
  branch: 'aa/run-20260101T000000Z', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:00.000Z', iterations: 1, usage: { totalTokens: 10, estimated: false },
  gated: [], reportPath: '.ai/runs/r1/report.md', reportError: null, runId: 'r1', resumed: false, buildFiles: [], ...over,
});
const roadmap = (root) => fs.readFileSync(path.join(root, '.ai/migration/roadmap.md'), 'utf8');
const rowStatus = (root, id) => roadmap(root).split('\n').find((l) => l.startsWith(`| \`${id}\` |`))?.split('|').slice(-2, -1)[0].trim();
const worker = (calls = []) => async (root, _c, opts) => {
  calls.push(opts.step.id);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', `${opts.step.id}.kt`), `// ${opts.step.id}\n`);
  return { status: { ok: true, status: { step: opts.step.id, status: 'done', summary: 'did it', filesChanged: [], verification: 'ok' } }, usage: { totalTokens: 10 }, exitCode: 0, signal: null, timedOut: false, outputTail: 'out' };
};
const okVerifier = async () => ({ ok: true, results: [{ argv: ['./gradlew', 'test'], exitCode: 0, tail: 'BUILD SUCCESSFUL', signature: '' }] });

// ---------- argv parsing ----------
test('parseArgs: valid forms, repeatable hashes lowercased', () => {
  const r = parseArgs(['--root', 'x', '--json', '--dry-run']);
  assert.equal(r.error, undefined);
  assert.deepEqual([r.root, r.json, r.dryRun, r.approved], ['x', true, true, []]);
  const h = parseArgs(['--approve-build-changes', HASH, '--approve-build-changes', 'B'.repeat(64)]);
  assert.deepEqual(h.approved, [HASH, 'b'.repeat(64)]);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs: strict rejections, and --yes does not exist', () => {
  const bad = [
    ['--yes', /--yes/], ['-y', /unknown option/], ['--yes=1', /--yes|unknown/], ['--bogus', /unknown option/], ['--agent', /unknown option/], ['--max-iterations', /unknown option/],
    ['--root', /needs a value/], ['--root', '--json', /needs a value/], ['--root', '-x', /needs a value/],
    ['--root', 'a', '--root', 'b', /more than once/], ['--json', '--json', /more than once/],
    ['--approve-build-changes', /needs a value/], ['--approve-build-changes', '--json', /needs a value/],
    ['--approve-build-changes', 'abc', /64 hex/], ['--approve-build-changes', 'g'.repeat(64), /64 hex/], ['--approve-build-changes', 'a'.repeat(65), /64 hex/],
    ['--approve-build-changes', HASH, '--approve-build-changes', HASH, /duplicate/],
    ['stray', /unexpected argument/], ['--root=/x', /unknown option/],
    ['--dry-run', '--approve-build-changes', HASH, /dry-run/],
  ];
  for (const b of bad) {
    const re = b.pop();
    const r = parseArgs(b);
    assert.match(r.error ?? '', re, JSON.stringify(b));
  }
  const many = [];
  for (let i = 0; i < 21; i++) many.push('--approve-build-changes', i.toString(16).padStart(64, '0'));
  assert.match(parseArgs(many).error, /at most 20/);
  assert.ok(!BOOLEAN_FLAGS.includes('yes') && !VALUE_FLAGS.includes('yes'));
  assert.deepEqual([...BOOLEAN_FLAGS].sort(), ['dry-run', 'help', 'json']);
  assert.deepEqual([...VALUE_FLAGS].sort(), ['approve-build-changes', 'root']);
});

test('main: usage errors exit 2 with a plain message and never start anything', async () => {
  let called = 0;
  const runLoop = async () => { called++; return fakeResult(); };
  for (const argv of [['--yes'], ['--bogus', 'x'], ['--approve-build-changes', 'zz']]) {
    const r = await run(argv, { root: os.tmpdir(), runLoop });
    assert.equal(r.code, EXIT.REFUSED);
    assert.match(r.err, /usage:/i);
    assert.equal(r.out, '');
  }
  assert.equal(called, 0);
  const help = await run(['--help'], { root: os.tmpdir(), runLoop });
  assert.equal(help.code, 0);
  assert.match(help.out, /--approve-build-changes <hash>/);
  assert.match(help.out, /git diff/);
  assert.match(help.out, /no --yes/i);
  assert.equal(USAGE.includes('--yes'), false);
});

test('flags with attacker-shaped values never reach git or the loop', async () => {
  const root = project(CHAIN, { config: CONFIG });
  let opts = null;
  const runLoop = async (_r, o) => { opts = o; return fakeResult(); };
  const r = await run(['--approve-build-changes', HASH, '--root', root], { root: os.tmpdir(), interactive: true, runLoop });
  assert.equal(r.code, 0);
  assert.deepEqual(opts.approvedBuildChanges, [HASH]);
  assert.equal(typeof opts.confirm, 'function');
});

// ---------- refusals ----------
test('refusals exit 2 with plain messages (no paths, no stack)', async () => {
  const cases = [];
  cases.push(['not gradle', project(CHAIN, { gradle: false }), /not an Android\/Gradle project/]);
  const noAi = project(CHAIN);
  fs.rmSync(path.join(noAi, '.ai'), { recursive: true });
  cases.push(['no .ai', noAi, /no \.ai\/ folder/]);
  const noPlan = project(CHAIN);
  fs.rmSync(path.join(noPlan, '.ai/migration/plan.json'));
  cases.push(['no plan', noPlan, /migration plan/]);
  cases.push(['bad config', project(CHAIN, { config: { agent: { kind: 'claude', command: ['bash', '-c', 'x'] } } }), /run\.config\.json/]);
  cases.push(['default branch', project(CHAIN, { config: CONFIG, branch: null }), /branch/]);
  const dirty = project(CHAIN, { config: CONFIG });
  fs.writeFileSync(path.join(dirty, 'dirty.txt'), 'x');
  cases.push(['dirty', dirty, /clean/]);
  for (const [name, root, re] of cases) {
    const r = await run(['--root', root], { root: os.tmpdir(), interactive: true, answers: ['yes'], runOptions: { agent: worker(), verifier: okVerifier } });
    assert.equal(r.code, EXIT.REFUSED, `${name}: ${r.all}`);
    assert.match(r.all, re, name);
    noLeaks(r.all, root);
    assert.doesNotMatch(r.all, /nothing was pushed/i, `${name}: refused prints no review line`);
  }
});

test('a root that does not exist is a plain refusal', async () => {
  const r = await run(['--root', path.join(os.tmpdir(), 'aa-no-such-dir-xyz')], { root: os.tmpdir() });
  assert.equal(r.code, 2);
  noLeaks(r.all);
});

// ---------- consent ----------
test('non-interactive stdin never confirms: exit 2, nothing recorded, agent not called', async () => {
  const root = project(CHAIN, { config: CONFIG });
  const calls = [];
  const r = await run(['--root', root], { root: os.tmpdir(), interactive: false, runOptions: { agent: worker(calls), verifier: okVerifier } });
  assert.equal(r.code, 2);
  assert.match(r.err, /interactive terminal/);
  assert.match(r.err, /no --yes|cannot be scripted/i);
  assert.deepEqual(calls, []);
  assert.deepEqual(r.asked, []);
  assert.ok(!fs.existsSync(path.join(root, '.git/android-architect')));
  assert.equal(g(root, 'status', '--porcelain').trim(), '');
  noLeaks(r.all, root);
});

test('non-interactive stdin in a real child process: exit 2 and plain', () => {
  const root = project(CHAIN, { config: CONFIG });
  const r = spawnSync(process.execPath, [RUN_JS, '--root', root], { encoding: 'utf8', stdin: 'ignore', input: '' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /interactive terminal/);
  noLeaks(r.stdout + r.stderr, root);
  const viaBin = spawnSync(process.execPath, [CLI, 'run', '--root', root], { encoding: 'utf8', input: 'yes\n' });
  assert.equal(viaBin.status, 2, 'piped "yes" is not a TTY and must not confirm');
  assert.ok(!fs.existsSync(path.join(root, '.git/android-architect')));
});

test('consent text lists argv, warnings, verification, passEnv names (never values), budgets, branch prefix and the no-push statement', async () => {
  const root = project(CHAIN, { config: CONFIG });
  const calls = [];
  const r = await run(['--root', root], { root: os.tmpdir(), interactive: true, answers: ['no'], env: { ANTHROPIC_API_KEY: FAKE_SECRET }, runOptions: { agent: worker(calls), verifier: okVerifier } });
  assert.equal(r.code, 2);
  assert.deepEqual(calls, []);
  assert.equal(r.asked.length, 1);
  const t = r.out;
  assert.match(t, /Agent command: claude -p \{prompt\} --output-format json --max-turns \{maxTurns\}/);
  assert.match(t, /unverified/);
  assert.match(t, /current .*CLI help/i);
  assert.ok(t.includes(NO_RESTRICTIONS_WARNING));
  assert.match(t, /Verification commands: \.\/gradlew assembleDebug testDebugUnitTest lint/);
  assert.match(t, /build code/i);
  assert.match(t, /ANTHROPIC_API_KEY/);
  assert.match(t, /names only|never shown/i);
  assert.match(t, /10 iterations/);
  assert.match(t, /400000 tokens/);
  assert.match(t, /aa\/run/);
  assert.match(t, /Nothing is pushed, merged or published/);
  assert.match(t, /HOME and PATH/);
  assert.ok(!r.all.includes(FAKE_SECRET));
  assert.ok(!fs.existsSync(path.join(root, '.git/android-architect/confirmed.json')));
});

test('only an explicit "yes" confirms; everything else declines', async () => {
  for (const ans of ['y', 'Y', '', '  ', 'no', 'yes please', 'ok', 'true', null]) {
    const root = project(CHAIN, { config: CONFIG });
    const calls = [];
    const r = await run(['--root', root], { root: os.tmpdir(), interactive: true, answers: [ans], runOptions: { agent: worker(calls), verifier: okVerifier } });
    assert.equal(r.code, 2, `answer ${JSON.stringify(ans)}`);
    assert.deepEqual(calls, []);
  }
});

test('end to end: a recorded consent lets a non-interactive rerun go; a changed config asks again', async () => {
  const root = project(mkPlan([S('a', 'First'), S('b', 'Second', { dependsOn: ['a'] })]), { config: CONFIG });
  const calls = [];
  const opts = { agent: worker(calls), verifier: okVerifier };
  const first = await run(['--root', root], { root: os.tmpdir(), interactive: true, answers: ['yes'], runOptions: opts });
  assert.equal(first.code, 0, first.all);
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(rowStatus(root, 'a'), 'done');
  assert.equal(rowStatus(root, 'b'), 'done');
  assert.equal(g(root, 'log', '--format=%s').split('\n').filter((s) => s.startsWith('feat(migration)')).length, 2);
  assert.match(first.out, /Outcome: done/);
  assert.match(first.out, /Nothing was pushed, merged or published/);
  assert.match(first.out, /\.ai\/runs\/r[0-9TZ-]+\/report\.md/);
  assert.ok(fs.existsSync(path.join(root, first.out.match(/(\.ai\/runs\/r[0-9TZ-]+\/report\.md)/)[1])));
  noLeaks(first.all, root);
  // consent recorded: a non-interactive rerun passes the consent check (here the run itself is already done)
  const again = await run(['--root', root], { root: os.tmpdir(), interactive: false, runOptions: opts });
  assert.equal(again.code, 0, again.all);
  assert.doesNotMatch(again.err, /interactive terminal/);
  // changing the config re-prompts, so a non-interactive run is refused again
  g(root, 'switch', '-q', 'feature');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.ai/run.config.json'), 'utf8'));
  cfg.budgets = { maxIterations: 3 };
  fs.writeFileSync(path.join(root, '.ai/run.config.json'), JSON.stringify(cfg));
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'cfg');
  const changed = await run(['--root', root], { root: os.tmpdir(), interactive: false, runOptions: opts });
  assert.equal(changed.code, 2);
  assert.match(changed.err, /interactive terminal/);
});

// ---------- exit codes ----------
test('exit-code table: every outcome mapped, only done is 0, codes stable and distinct per class', async () => {
  assert.deepEqual(OUTCOME_EXIT, {
    done: 0, refused: 2, 'needs-human': 3, stopped: 4, interrupted: 4, tampered: 5, budget: 6, 'no-progress': 6, 'repeated-error': 6, 'verification-failed': 6, failed: 7,
  });
  assert.deepEqual(Object.keys(OUTCOME_EXIT).sort(), [...OUTCOMES].sort());
  for (const o of OUTCOMES) assert.equal(OUTCOME_EXIT[o] === 0, o === 'done', o);
  assert.deepEqual(EXIT, { OK: 0, REFUSED: 2, NEEDS_HUMAN: 3, STOPPED: 4, TAMPERED: 5, LIMIT: 6, FAILED: 7 });
  const root = project(CHAIN, { config: CONFIG });
  for (const o of OUTCOMES) {
    const r = await run(['--root', root], { root: os.tmpdir(), interactive: true, runLoop: async () => fakeResult({ outcome: o, reason: `why ${o}` }) });
    assert.equal(r.code, OUTCOME_EXIT[o], o);
    assert.match(r.out, new RegExp(`Outcome: ${o}`));
    if (o === 'refused') assert.doesNotMatch(r.out, /nothing was pushed/i);
    else assert.match(r.out, /Nothing was pushed, merged or published; review the branch/);
  }
});

test('no path exits 0 after an error', async () => {
  const root = project(CHAIN, { config: CONFIG });
  const go = (runLoop) => run(['--root', root], { root: os.tmpdir(), interactive: true, runLoop });
  assert.equal((await go(async () => fakeResult({ outcome: 'weird' }))).code, EXIT.FAILED);
  assert.equal((await go(async () => fakeResult({ outcome: undefined }))).code, EXIT.FAILED);
  assert.equal((await go(async () => null)).code, EXIT.FAILED);
  const thrown = await go(async () => { throw new Error(`boom at ${root}/x`); });
  assert.equal(thrown.code, EXIT.FAILED);
  noLeaks(thrown.all, root);
  const noReport = await go(async () => fakeResult({ reportError: 'the report could not be written: EACCES', reportPath: null }));
  assert.equal(noReport.code, EXIT.FAILED);
  assert.match(noReport.all, /report could not be written/);
});

// ---------- output ----------
test('--json prints one redacted, sanitized, bounded object and nothing else on stdout', async () => {
  const root = project(CHAIN, { config: CONFIG });
  const hostile = fakeResult({
    outcome: 'needs-human',
    reason: `key AKIAIOSFODNN7EXAMPLE \u001b[31mred‮ ${LEAK}`,
    steps: [{ id: 'a', title: 'T\u0000itle\nforged | row `x`', status: 'doing', result: 'x'.repeat(5000), iterations: 1, commit: null, summary: 'Authorization: Bearer abcDEF1234567890ghijklMNOPqrst99', diffFiles: ['a.kt'], extra: 'raw agent output' }],
    outputTail: 'RAW AGENT OUTPUT', logText: 'RAW',
    gated: [{ id: 'c', tags: ['decision'] }], buildFiles: ['build.gradle'],
  });
  const r = await run(['--root', root, '--json'], { root: os.tmpdir(), interactive: true, runLoop: async () => hostile });
  assert.equal(r.code, EXIT.NEEDS_HUMAN);
  const lines = r.out.trimEnd().split('\n');
  assert.equal(lines.length > 0, true);
  const j = JSON.parse(r.out);
  assert.equal(j.outcome, 'needs-human');
  assert.equal(j.exitCode, 3);
  assert.equal(j.nothingPushed, true);
  assert.equal(j.branch, 'aa/run-20260101T000000Z');
  assert.equal(j.reportPath, '.ai/runs/r1/report.md');
  assert.ok(Array.isArray(j.steps) && Array.isArray(j.gated) && Array.isArray(j.buildFiles));
  assert.ok(!r.out.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!r.out.includes(LEAK));
  assert.ok(!r.out.includes('abcDEF1234567890ghijklMNOPqrst99'));
  assert.doesNotMatch(r.out, /RAW AGENT OUTPUT|RAW"/);
  assert.doesNotMatch(r.out, /[\u0000-\u0008\u001b‮]/);
  assert.equal(j.steps[0].extra, undefined);
  assert.ok(j.steps[0].result.length <= 80);
  assert.ok(r.out.length < 20000);
});

test('human summary: outcome, reason, branch, per-step table, report path; hostile text is neutralized', async () => {
  const root = project(CHAIN, { config: CONFIG });
  const res = fakeResult({
    outcome: 'verification-failed', reason: `verification failed\u001b[2J AKIAIOSFODNN7EXAMPLE`,
    steps: [{ id: 'a', title: 'First\r\nOutcome: done', status: 'doing', result: 'verification-failed', iterations: 2, commit: null, summary: '', diffFiles: [] }],
  });
  const r = await run(['--root', root], { root: os.tmpdir(), interactive: true, runLoop: async () => res });
  assert.equal(r.code, EXIT.LIMIT);
  assert.match(r.out, /Outcome: verification-failed/);
  assert.match(r.out, /Reason: verification failed/);
  assert.match(r.out, /Branch: aa\/run-20260101T000000Z/);
  assert.match(r.out, /Steps:\n.*\ba\b.*doing.*verification-failed/);
  assert.match(r.out, /Report: \.ai\/runs\/r1\/report\.md/);
  assert.doesNotMatch(r.out, /\u001b|AKIAIOSFODNN7EXAMPLE/);
  assert.equal((r.out.match(/^Outcome:/gm) ?? []).length, 1, 'a title cannot forge an Outcome line');
  const many = fakeResult({ steps: Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, title: 't', status: 'done', result: 'ok', iterations: 1, commit: null, summary: '', diffFiles: [] })) });
  const big = await run(['--root', root], { root: os.tmpdir(), interactive: true, runLoop: async () => many });
  assert.ok(big.out.split('\n').length < 400);
  assert.match(big.out, /more steps/);
});

test('needs-human for build files tells how to approve and what to review first', async () => {
  const root = project(CHAIN, { config: CONFIG });
  const res = fakeResult({ outcome: 'needs-human', reason: `build files changed: 1 — review, then rerun with --approve-build-changes ${HASH}`, buildFiles: ['build.gradle.kts'] });
  const r = await run(['--root', root], { root: os.tmpdir(), interactive: true, runLoop: async () => res });
  assert.equal(r.code, 3);
  assert.match(r.out, /build\.gradle\.kts/);
  assert.match(r.out, /git diff/);
  assert.match(r.out, /git status/);
});

// ---------- dry run ----------
test('--dry-run prints the plan and touches nothing', async () => {
  const root = project(CHAIN, { config: CONFIG });
  let called = 0;
  const before = g(root, 'status', '--porcelain', '--ignored');
  const r = await run(['--root', root, '--dry-run'], { root: os.tmpdir(), interactive: true, env: { ANTHROPIC_API_KEY: FAKE_SECRET }, runLoop: async () => { called++; return fakeResult(); }, runOptions: { agent: worker(), verifier: okVerifier } });
  assert.equal(r.code, 0, r.all);
  assert.equal(called, 0);
  assert.deepEqual(r.asked, []);
  assert.match(r.out, /Dry run/);
  assert.match(r.out, /Agent command: claude -p/);
  assert.match(r.out, /ANTHROPIC_API_KEY/);
  assert.match(r.out, /Next step: a /);
  assert.match(r.out, /needs a human[^\n]*\bc\b|\bc\b[^\n]*decision/i);
  assert.match(r.out, /build files/i);
  assert.ok(!r.all.includes(FAKE_SECRET));
  assert.equal(g(root, 'status', '--porcelain', '--ignored'), before);
  assert.equal(g(root, 'status', '--porcelain').trim(), '');
  assert.ok(!fs.existsSync(path.join(root, '.ai/runs')));
  assert.ok(!fs.existsSync(path.join(root, '.git/android-architect')));
  assert.equal(g(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature');
  noLeaks(r.all, root);
  const j = await run(['--root', root, '--dry-run', '--json'], { root: os.tmpdir() });
  const d = JSON.parse(j.out);
  assert.equal(d.dryRun, true);
  assert.equal(d.next.id, 'a');
  assert.deepEqual(d.passEnv, ['ANTHROPIC_API_KEY']);
  assert.equal(d.agentArgv[0], 'claude');
  assert.ok(Array.isArray(d.gated) && d.gated[0].id === 'c');
  assert.ok(!fs.existsSync(path.join(root, '.ai/runs')));
});

test('--dry-run on an invalid project is still a refusal (exit 2) and touches nothing', async () => {
  const root = project(CHAIN, { config: { agent: { kind: 'claude', command: ['sh', '-c', 'x'] } } });
  const r = await run(['--root', root, '--dry-run'], { root: os.tmpdir() });
  assert.equal(r.code, 2);
  assert.ok(!fs.existsSync(path.join(root, '.ai/runs')));
});

// ---------- signals and source rules ----------
test('the CLI installs no signal listeners and no process.exit in run.js', async () => {
  const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
  const before = sigs.map((s) => process.listenerCount(s));
  const root = project(CHAIN, { config: CONFIG });
  let during = null;
  await run(['--root', root], { root: os.tmpdir(), interactive: true, runLoop: async () => { during = sigs.map((s) => process.listenerCount(s)); return fakeResult(); } });
  assert.deepEqual(during, before);
  assert.deepEqual(sigs.map((s) => process.listenerCount(s)), before);
  const src = fs.readFileSync(RUN_JS, 'utf8');
  assert.doesNotMatch(src, /process\.(on|once|addListener|prependListener)\(/);
  assert.doesNotMatch(src, /process\.exit\(/);
  assert.doesNotMatch(src, /process\.env/, 'option values never come from the environment');
});

test('run.js never reads approved hashes from config, env or files', () => {
  const src = fs.readFileSync(RUN_JS, 'utf8');
  assert.doesNotMatch(src, /readFileSync|process\.env|approvedBuildChanges\s*[:=]\s*(config|cfg)/);
});

// ---------- bin/cli.js ----------
test('bin/cli.js run delegates to run.js; usage lists run and its flags', () => {
  const root = project(CHAIN, { config: CONFIG });
  const r = spawnSync(process.execPath, [CLI, 'run', '--root', root, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run/);
  const bad = spawnSync(process.execPath, [CLI, 'run', '--yes'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--yes/);
  const usage = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /\brun\b/);
  for (const f of [...BOOLEAN_FLAGS, ...VALUE_FLAGS]) assert.ok(usage.stderr.includes(`--${f}`), `cli usage must list --${f}`);
  assert.match(usage.stderr, /--approve-build-changes <hash>/);
  const ver = spawnSync(process.execPath, [CLI, 'version'], { encoding: 'utf8' });
  assert.equal(ver.status, 0);
});
