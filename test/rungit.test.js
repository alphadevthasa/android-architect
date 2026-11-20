import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  RunRefusal,
  assertNeverNetwork,
  runGit,
  startRunBranch,
  commitStep,
  diffSince,
  hasChanges,
  confirmFirstUse,
} from '../skill/scripts/lib/rungit.js';
import { DEFAULT_RUN_CONFIG, loadRunConfig } from '../skill/scripts/lib/runconfig.js';

const tmps = [];
const mk = (p = 'aa-rungit-') => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  tmps.push(d);
  return d;
};
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const g = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const write = (root, rel, text = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
/** Repo with one commit on `branch`, a local identity, and an .ai folder. */
function repo(branch = 'main', { commit = true } = {}) {
  const d = mk();
  g(d, 'init', '-q', '-b', branch);
  g(d, 'config', 'user.name', 't');
  g(d, 'config', 'user.email', 't@example.invalid');
  write(d, 'README.md', '# t\n');
  fs.mkdirSync(path.join(d, '.ai'));
  if (commit) {
    g(d, 'add', '-A');
    g(d, 'commit', '-q', '-m', 'init');
  }
  return d;
}
const NOW = new Date(Date.UTC(2026, 10, 20, 12, 34, 56));
const PREFIX = 'android-architect/run';
const start = (root, extra = {}) => startRunBranch(root, { branchPrefix: PREFIX, now: NOW, ...extra });
const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof RunRefusal && re.test(e.message) && !/\n\s+at /.test(e.message) && !e.message.includes(os.tmpdir()), `expected RunRefusal ${re}`);
const branchOf = (d) => g(d, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

// ---------- assertNeverNetwork ----------
test('assertNeverNetwork rejects every forbidden subcommand, option and executable', () => {
  for (const sub of ['push', 'fetch', 'pull', 'clone', 'remote', 'merge', 'rebase', 'submodule', 'ls-remote', 'request-pull', 'send-email', 'daemon', 'instaweb']) {
    assert.throws(() => assertNeverNetwork(['git', sub]), RunRefusal, sub);
    assert.throws(() => assertNeverNetwork([sub, 'origin']), RunRefusal, sub);
    assert.throws(() => assertNeverNetwork(['git', '-c', 'a=b', '--no-pager', sub.toUpperCase()]), RunRefusal, sub);
  }
  for (const a of ['--upload-pack=x', '--receive-pack', '--exec=evil']) assert.throws(() => assertNeverNetwork(['git', 'status', a]), RunRefusal, a);
  for (const exe of ['curl', 'wget', 'ssh', 'scp', 'nc', '/usr/bin/curl']) assert.throws(() => assertNeverNetwork([exe, 'x']), RunRefusal, exe);
  assert.throws(() => assertNeverNetwork(['npm', 'publish']), RunRefusal);
  assert.doesNotThrow(() => assertNeverNetwork(['git', 'status', '--porcelain=v1']));
  assert.doesNotThrow(() => assertNeverNetwork(['git', 'commit', '-m', 'feat(migration): s1: merge the pull request logic']));
});

test('runGit applies assertNeverNetwork before spawning anything', () => {
  const d = repo();
  assert.throws(() => runGit(d, ['push', 'origin', 'main']), RunRefusal);
  assert.throws(() => runGit(d, ['fetch']), RunRefusal);
});

// ---------- startRunBranch refusals ----------
test('refuses: not a repo, no commits, detached HEAD (distinct messages, nothing changed)', () => {
  const plain = mk();
  refuses(() => start(plain), /not a git repository/);
  assert.deepEqual(fs.readdirSync(plain), []);

  const none = repo('feature', { commit: false });
  refuses(() => start(none), /no commits/);

  const det = repo('feature');
  g(det, 'checkout', '-q', '--detach');
  refuses(() => start(det), /detached HEAD/);
  assert.equal(g(det, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD');
  assert.equal(g(det, 'status', '--porcelain'), '');
});

test('refuses default branches: main, master, trunk, develop, origin/HEAD target, protectedBranches', () => {
  for (const b of ['main', 'master', 'trunk', 'develop']) {
    const d = repo(b);
    refuses(() => start(d), /default branch/);
    assert.equal(branchOf(d), b);
  }
  const d = repo('mainline-x');
  g(d, 'update-ref', 'refs/remotes/origin/mainline-x', 'HEAD');
  g(d, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/mainline-x');
  refuses(() => start(d), /default branch/);
  const e = repo('custom-default');
  const r = start(e, { protectedBranches: [] }); // limitation: undetectable without origin/HEAD or the list
  assert.match(r.branch, /^android-architect\/run-/);
  const f = repo('custom-default');
  refuses(() => start(f, { protectedBranches: ['custom-default'] }), /default branch/);
});

test('refuses a dirty tracked file and an untracked file, tree untouched; .ai/runs/ is ignored', () => {
  const a = repo('feature');
  write(a, 'README.md', 'changed\n');
  refuses(() => start(a), /not clean|dirty/);
  assert.equal(fs.readFileSync(path.join(a, 'README.md'), 'utf8'), 'changed\n');
  assert.equal(branchOf(a), 'feature');

  const b = repo('feature');
  write(b, 'new dir/ünï file.txt');
  refuses(() => start(b), /not clean|dirty/);

  const staged = repo('feature');
  write(staged, 'a.txt');
  g(staged, 'add', 'a.txt');
  refuses(() => start(staged), /not clean|dirty/);

  const c = repo('feature');
  write(c, '.ai/runs/2026/log.txt');
  write(c, '.ai/runs/.confirmed', '{}');
  assert.equal(start(c).baseBranch, 'feature');
});

test('refuses when .ai/runs contains tracked files (forged consent)', () => {
  const d = repo('feature');
  write(d, '.ai/runs/.confirmed', '{"schemaVersion":1,"hash":"x"}');
  g(d, 'add', '-f', '.ai/runs/.confirmed');
  g(d, 'commit', '-q', '-m', 'pr');
  refuses(() => start(d), /tracked/);
});

// ---------- startRunBranch success / resume ----------
test('creates the run branch from HEAD, excludes .ai/runs/, and a re-run resumes', () => {
  const d = repo('feature');
  const base = g(d, 'rev-parse', 'HEAD').trim();
  const r = start(d);
  assert.equal(r.branch, 'android-architect/run-20261120-123456');
  assert.equal(r.baseBranch, 'feature');
  assert.equal(r.baseCommit, base);
  assert.equal(branchOf(d), r.branch);
  assert.match(fs.readFileSync(path.join(d, '.git/info/exclude'), 'utf8'), /^\/\.ai\/runs\/$/m);
  const again = startRunBranch(d, { branchPrefix: PREFIX, now: new Date(NOW.getTime() + 5000) });
  assert.equal(again.branch, r.branch);
  assert.equal(again.resumed, true);
  assert.equal(g(d, 'branch', '--list').split('\n').filter((l) => l.includes('android-architect')).length, 1);
});

test('resume tolerates only the listed dirty paths', () => {
  const d = repo('feature');
  write(d, '.ai/migration/roadmap.md', 'a\n');
  g(d, 'add', '-A');
  g(d, 'commit', '-q', '-m', 'roadmap');
  start(d);
  write(d, '.ai/migration/roadmap.md', 'doing\n');
  refuses(() => start(d), /not clean|dirty/);
  assert.equal(start(d, { resumeDirtyOk: ['.ai/migration/roadmap.md'] }).resumed, true);
  write(d, 'other.txt');
  refuses(() => start(d, { resumeDirtyOk: ['.ai/migration/roadmap.md'] }), /not clean|dirty/);
});

test('a branch that already exists is not overwritten', () => {
  const d = repo('feature');
  g(d, 'branch', 'android-architect/run-20261120-123456');
  refuses(() => start(d), /already exists/);
});

// ---------- commitStep ----------
test('commitStep makes one commit without trailers, stages roadmap + code together, null on empty diff', () => {
  const d = repo('feature');
  start(d);
  assert.equal(commitStep(d, { id: 'extract:feature-login', title: 't' }), null);
  write(d, 'src/A.kt', 'class A\n');
  write(d, '.ai/migration/roadmap.md', 'done\n');
  write(d, '.ai/runs/log.txt', 'run log\n');
  const res = commitStep(d, { id: 'extract:feature-login', title: 'Extract login\nmodule' });
  assert.match(res.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(res.filesChanged.sort(), ['.ai/migration/roadmap.md', 'src/A.kt']);
  const msg = g(d, 'log', '-1', '--format=%B').trim();
  assert.equal(msg, 'feat(migration): extract:feature-login: Extract login module');
  assert.doesNotMatch(msg, /Co-Authored-By|Claude-Session/i);
  assert.equal(g(d, 'status', '--porcelain', '--untracked-files=all').trim(), '');
  assert.doesNotMatch(g(d, 'ls-files'), /\.ai\/runs/);
  assert.equal(commitStep(d, { id: 'x', title: 't' }), null);
});

test('commit subject is at most 72 chars, step id is sanitized, secrets in the title are redacted', () => {
  const d = repo('feature');
  start(d);
  write(d, 'a.txt');
  const r = commitStep(d, { id: 'A b;$(touch x)', title: 'y'.repeat(200) });
  assert.ok(r);
  const msg = g(d, 'log', '-1', '--format=%s').trim();
  assert.ok(msg.length <= 72, msg);
  assert.match(msg, /^feat\(migration\): [a-z0-9:_.-]+: y+$/);
  assert.equal(fs.existsSync(path.join(d, 'x')), false);
  write(d, 'b.txt');
  commitStep(d, { id: 's2', title: 'token = AKIAIOSFODNN7EXAMPLE' });
  assert.doesNotMatch(g(d, 'log', '-1', '--format=%s'), /AKIAIOSFODNN7EXAMPLE/);
});

test('commitStep refuses a symlink that points outside the repo and unstages', () => {
  const d = repo('feature');
  start(d);
  const outside = mk('aa-outside-');
  fs.symlinkSync(outside, path.join(d, 'evil link'));
  write(d, 'ok.txt');
  refuses(() => commitStep(d, { id: 's1', title: 't' }), /symlink.*outside|outside.*symlink/);
  assert.equal(g(d, 'diff', '--cached', '--name-only').trim(), '');
  assert.equal(g(d, 'rev-parse', 'HEAD').trim(), g(d, 'rev-parse', 'refs/heads/feature').trim());
});

test('commitStep accepts a symlink that stays inside the repo, refuses relative escapes', () => {
  const d = repo('feature');
  start(d);
  fs.symlinkSync('README.md', path.join(d, 'inside'));
  assert.ok(commitStep(d, { id: 's1', title: 't' }));
  fs.symlinkSync('../../../../etc/passwd', path.join(d, 'esc'));
  refuses(() => commitStep(d, { id: 's2', title: 't' }), /symlink/);
});

test('commitStep refuses a 6 MB file and accepts a file just under 5 MB', () => {
  const d = repo('feature');
  start(d);
  write(d, 'big.bin', 'a'.repeat(6 * 1024 * 1024));
  refuses(() => commitStep(d, { id: 's1', title: 't' }), /larger than 5 MB.*big\.bin/);
  assert.equal(g(d, 'diff', '--cached', '--name-only').trim(), '');
  fs.rmSync(path.join(d, 'big.bin'));
  write(d, 'ok.bin', 'a'.repeat(5 * 1024 * 1024 - 10));
  assert.ok(commitStep(d, { id: 's2', title: 't' }));
});

test('commitStep sanitizes the offending path in a refusal', () => {
  const d = repo('feature');
  start(d);
  write(d, 'big‮\tname.bin', 'a'.repeat(6 * 1024 * 1024));
  assert.throws(() => commitStep(d, { id: 's1', title: 't' }), (e) => e instanceof RunRefusal && !/[‮\t\n]/.test(e.message));
});

test('commitStep fails clearly without a git identity and never invents one', () => {
  const d = repo('feature');
  start(d);
  g(d, 'config', '--unset', 'user.name');
  g(d, 'config', '--unset', 'user.email');
  write(d, 'a.txt');
  const home = mk('aa-home-');
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  const savedEnv = {};
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = home;
  try {
    refuses(() => commitStep(d, { id: 's1', title: 't' }), /user\.name.*user\.email|identity/);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG;
    for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  }
  assert.equal(g(d, 'rev-parse', 'HEAD').trim(), g(d, 'rev-parse', 'refs/heads/feature').trim());
});

test('commitStep in a project that is a subfolder of the repo stages only the project', () => {
  const top = repo('feature');
  const sub = path.join(top, 'app');
  fs.mkdirSync(path.join(sub, '.ai'), { recursive: true });
  write(sub, 'a.txt');
  g(top, 'add', '-A');
  g(top, 'commit', '-q', '-m', 'sub');
  start(sub);
  write(sub, 'b.txt');
  write(top, 'outside.txt');
  const r = commitStep(sub, { id: 's1', title: 't' });
  assert.deepEqual(r.filesChanged, ['b.txt']);
  assert.equal(g(top, 'status', '--porcelain').trim(), '?? outside.txt');
});

// ---------- diffSince / hasChanges ----------
test('diffSince counts files and lines; hasChanges ignores .ai/runs and listed paths', () => {
  const d = repo('feature');
  start(d);
  const base = g(d, 'rev-parse', 'HEAD').trim();
  assert.equal(hasChanges(d), false);
  write(d, '.ai/runs/x.log', 'l\n');
  assert.equal(hasChanges(d), false);
  write(d, 'a.txt', '1\n2\n3\n');
  assert.equal(hasChanges(d), true);
  assert.equal(hasChanges(d, { ignore: ['a.txt'] }), false);
  commitStep(d, { id: 's1', title: 't' });
  write(d, 'README.md', '# t\nmore\n');
  commitStep(d, { id: 's2', title: 't' });
  const r = diffSince(d, base);
  assert.deepEqual(r.files.sort(), ['README.md', 'a.txt']);
  assert.equal(r.insertions, 4);
  assert.equal(r.deletions, 0);
  assert.throws(() => diffSince(d, '--output=x'), RunRefusal);
});

// ---------- recorded spawns ----------
test('every git invocation avoids push/fetch/remote/merge (PATH shim)', () => {
  const bin = mk('aa-shim-');
  const log = path.join(bin, 'calls.log');
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const d = repo('feature');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    start(d);
    write(d, 'a.txt');
    commitStep(d, { id: 's1', title: 't' });
    hasChanges(d);
    process.env.PATH = oldPath; // the test helper's own git must not be recorded
    const prev = g(d, 'rev-parse', 'HEAD~1').trim();
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    diffSince(d, prev);
  } finally {
    process.env.PATH = oldPath;
  }
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.ok(calls.length > 5);
  for (const c of calls) {
    assert.doesNotMatch(c, /(^| )(push|fetch|pull|remote|merge|clone|rebase)( |$)/, c);
    assert.match(c, /core\.hooksPath=\/dev\/null/);
    assert.match(c, /core\.fsmonitor=false/);
  }
});

// ---------- hardening ----------
test('repo-local config cannot execute code through runGit (fsmonitor, alias, external diff); the scan refuses such a repo', () => {
  const d = repo('feature');
  const marker = path.join(d, '..', `marker-${path.basename(d)}`);
  tmps.push(marker);
  const script = path.join(d, '..', `fsm-${path.basename(d)}.sh`);
  tmps.push(script);
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  g(d, 'config', 'core.fsmonitor', script);
  g(d, 'config', 'alias.status', `!touch '${marker}'`);
  g(d, 'config', 'diff.external', script);
  // Positive control: plain git does run the fsmonitor script.
  execFileSync('git', ['status', '--porcelain'], { cwd: d, stdio: 'ignore' });
  assert.equal(fs.existsSync(marker), true, 'control: fsmonitor should run for plain git');
  fs.rmSync(marker);
  runGit(d, ['status', '--porcelain=v1']);
  runGit(d, ['diff', '--no-ext-diff', 'HEAD']);
  assert.equal(fs.existsSync(marker), false, 'runGit must not execute repo-local config commands');
  refuses(() => start(d), /core\.fsmonitor|diff\.external|alias/);
  refuses(() => hasChanges(d), /run programs/);
  assert.equal(fs.existsSync(marker), false);
});

test('hostile GIT_* variables in process.env are dropped', () => {
  const d = repo('feature');
  const other = repo('main');
  const marker = path.join(mk('aa-m-'), 'ran');
  const script = path.join(mk('aa-s-'), 'x.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const names = { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_SSH_COMMAND: script, GIT_EXTERNAL_DIFF: script, GIT_ASKPASS: script, GIT_PROXY_COMMAND: script, GIT_EXEC_PATH: other, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: script, GIT_INDEX_FILE: path.join(other, 'idx') };
  const saved = {};
  for (const [k, v] of Object.entries(names)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    assert.equal(runGit(d, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature');
    assert.equal(runGit(d, ['rev-parse', '--show-toplevel']).trim(), d);
    assert.equal(start(d).baseBranch, 'feature');
    write(d, 'a.txt');
    assert.ok(commitStep(d, { id: 's1', title: 't' }));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(fs.existsSync(marker), false);
  assert.equal(branchOf(other), 'main');
});

// ---------- confirmFirstUse ----------
const cfgFile = (root, text) => write(root, '.ai/run.config.json', text);
test('confirmFirstUse prompts, writes a hash-bound consent, and re-prompts on any config or argv change', async () => {
  const d = repo('feature');
  const text = JSON.stringify({ schemaVersion: 1 });
  cfgFile(d, text);
  const config = loadRunConfig(d);
  const argv = ['claude', '-p'];
  const said = [];
  let asked = 0;
  const confirm = () => (asked++, true);
  assert.equal(await confirmFirstUse(d, { confirm, say: (s) => said.push(s), config, agentArgv: argv }), true);
  assert.equal(asked, 1);
  const out = said.join('\n');
  assert.match(out, /verification runs your project's Gradle build code and may reach the network/);
  assert.match(out, /run as you|run as the user|as your user/i);
  const consentPath = path.join(d, '.git/android-architect/confirmed.json');
  assert.equal(fs.statSync(consentPath).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(d, '.ai/runs/.confirmed')), false);
  const consent = JSON.parse(fs.readFileSync(consentPath, 'utf8'));
  const expected = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(text), Buffer.from('\n' + JSON.stringify(argv))])).digest('hex');
  assert.equal(consent.schemaVersion, 1);
  assert.equal(consent.hash, expected);
  assert.match(consent.confirmedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(fs.readFileSync(path.join(d, '.git/info/exclude'), 'utf8'), /^\/\.ai\/runs\/$/m);
  // same config and argv: no prompt
  assert.equal(await confirmFirstUse(d, { confirm, say: () => {}, config, agentArgv: argv }), true);
  assert.equal(asked, 1);
  // changed argv: prompt again
  assert.equal(await confirmFirstUse(d, { confirm: () => (asked++, false), say: () => {}, config, agentArgv: ['claude', '-p', '--x'] }), false);
  assert.equal(asked, 2);
  // one byte of the config changes: prompt again
  cfgFile(d, text + ' ');
  assert.equal(await confirmFirstUse(d, { confirm: () => (asked++, false), say: () => {}, config, agentArgv: argv }), false);
  assert.equal(asked, 3);
  // declined does not rewrite the consent
  assert.equal(JSON.parse(fs.readFileSync(consentPath, 'utf8')).hash, expected);
});

test('a consent file shipped inside the working tree is ignored; garbage in the git dir is ignored', async () => {
  const d = repo('feature');
  cfgFile(d, '{"schemaVersion":1}');
  const config = loadRunConfig(d);
  const hash = crypto.createHash('sha256').update('{"schemaVersion":1}\n["claude"]').digest('hex');
  for (const rel of ['.ai/runs/.confirmed', '.ai/.confirmed', '.confirmed', '.git/../android-architect/confirmed.json']) {
    write(d, rel, JSON.stringify({ schemaVersion: 1, hash, confirmedAt: 'x' }));
  }
  let asked = 0;
  assert.equal(await confirmFirstUse(d, { confirm: () => (asked++, false), say: () => {}, config, agentArgv: ['claude'] }), false);
  assert.equal(asked, 1);
  write(d, '.git/android-architect/confirmed.json', 'not json');
  assert.equal(await confirmFirstUse(d, { confirm: () => (asked++, false), say: () => {}, config, agentArgv: ['claude'] }), false);
  assert.equal(asked, 2);
});

test('tracked .ai/runs in any letter case (core.ignorecase=true) is refused and cannot pre-confirm', async () => {
  for (const rel of ['.AI/RUNS/.confirmed', '.Ai/runs/x.log', '.ai/Runs/.confirmed']) {
    const d = repo('feature');
    g(d, 'config', 'core.ignorecase', 'true');
    cfgFile(d, '{"schemaVersion":1}');
    write(d, rel, '{}');
    g(d, 'add', '-f', '-A');
    g(d, 'commit', '-q', '-m', 'forged');
    refuses(() => start(d), /tracked/);
    await assert.rejects(() => confirmFirstUse(d, { confirm: () => true, say: () => {}, config: loadRunConfig(d), agentArgv: ['claude'] }), (e) => e instanceof RunRefusal && /tracked/.test(e.message));
  }
});

test('confirmFirstUse input checks: confirm must be a function; config must match the bytes; statement mentions inherited HOME/PATH', async () => {
  const d = repo('feature');
  cfgFile(d, '{"schemaVersion":1}');
  const config = loadRunConfig(d);
  await assert.rejects(() => confirmFirstUse(d, { confirm: true, say: () => {}, config, agentArgv: ['claude'] }), RunRefusal);
  await assert.rejects(() => confirmFirstUse(d, { confirm: () => true, say: () => {}, config: { ...config, branchPrefix: 'other/x' }, agentArgv: ['claude'] }), (e) => e instanceof RunRefusal && /changed/.test(e.message));
  const said = [];
  await confirmFirstUse(d, { confirm: () => false, say: (x) => said.push(x), config, agentArgv: ['claude'] });
  assert.match(said.join('\n'), /HOME and PATH.*~\/\.ssh/);
  fs.rmSync(path.join(d, '.ai/run.config.json'));
  fs.symlinkSync('/etc/hosts', path.join(d, '.ai/run.config.json'));
  await assert.rejects(() => confirmFirstUse(d, { confirm: () => true, say: () => {}, config, agentArgv: ['claude'] }), RunRefusal);
});

test('confirmFirstUse statement is sanitized and does not print stack or absolute paths', async () => {
  const d = repo('feature');
  cfgFile(d, '{"schemaVersion":1}');
  const config = loadRunConfig(d);
  const said = [];
  await confirmFirstUse(d, { confirm: () => false, say: (s) => said.push(s), config, agentArgv: ['claude', 'token=AKIAIOSFODNN7EXAMPLE‮\nforged line'] });
  const out = said.join('\n');
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE|‮/);
  assert.equal(out.includes(d), false);
});

// ---------- repo-local config that runs programs ----------
const gitPlain = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
function filterRepo(extraCfg = []) {
  const d = repo('feature');
  const markerDir = mk('aa-mk-');
  const marker = path.join(markerDir, 'ran');
  const script = path.join(markerDir, 'f.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  g(d, 'config', 'filter.x.clean', script);
  g(d, 'config', 'filter.x.smudge', script);
  write(d, '.gitattributes', '*.txt filter=x\n');
  g(d, 'add', '.gitattributes');
  g(d, 'config', '--unset', 'filter.x.clean');
  g(d, 'commit', '-q', '-m', 'attrs');
  g(d, 'config', 'filter.x.clean', script);
  for (const [k, v] of extraCfg) g(d, 'config', k, v);
  write(d, 'a.txt', 'hello\n');
  return { d, marker };
}

test('a repo-local clean filter is refused everywhere and never runs (plain git does run it)', () => {
  const { d, marker } = filterRepo();
  gitPlain(d, 'add', '-A');
  assert.equal(fs.existsSync(marker), true, 'control: plain git add runs the filter');
  gitPlain(d, 'reset', '-q');
  fs.rmSync(marker);
  refuses(() => start(d), /filter\.x\..*run programs/);
  refuses(() => hasChanges(d), /filter\./);
  refuses(() => commitStep(d, { id: 's1', title: 't' }), /filter\./);
  refuses(() => diffSince(d, g(d, 'rev-parse', 'HEAD').trim()), /filter\./);
  assert.equal(fs.existsSync(marker), false, 'the runner path must not run the filter');
  assert.equal(branchOf(d), 'feature');
});

test('runGit alone neutralizes repo-local filters with empty overrides (defense in depth)', () => {
  const { d, marker } = filterRepo();
  runGit(d, ['add', '-A']);
  runGit(d, ['status', '--porcelain=v1']);
  assert.equal(fs.existsSync(marker), false);
});

test('other program-running repo-local keys are refused: merge driver, diff textconv, fsmonitor, core.worktree, include, info/attributes', () => {
  const cases = [
    [['merge.m.driver', 'x %A'], /merge\.m\.driver/],
    [['diff.d.textconv', 'cat'], /diff\.d\.textconv/],
    [['core.fsmonitor', '/bin/true'], /core\.fsmonitor/],
    [['core.sshCommand', 'x'], /core\.sshcommand/],
    [['core.pager', 'x'], /core\.pager/],
    [['core.editor', 'x'], /core\.editor/],
    [['include.path', '/nonexistent-aa-dir/x.cfg'], /include\.path/],
  ];
  for (const [[k, v], re] of cases) {
    const d = repo('feature');
    g(d, 'config', k, v);
    refuses(() => start(d), re);
    assert.equal(branchOf(d), 'feature');
  }
  const d = repo('feature');
  const other = repo('feature');
  g(d, 'config', 'core.worktree', other);
  refuses(() => start(d), /core\.worktree|working tree git reports/);
  const e = repo('feature');
  write(e, '.git/info/attributes', '*.txt filter=x\n');
  refuses(() => start(e), /info\/attributes/);
});

test('a filter defined only in the user global config is trusted, not refused', () => {
  const home = mk('aa-home-');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = t\n\temail = t@example.invalid\n[filter "lfsish"]\n\tclean = cat\n\tsmudge = cat\n');
  const d = repo('feature');
  write(d, '.gitattributes', '*.bin filter=lfsish\n');
  g(d, 'add', '.gitattributes');
  g(d, 'commit', '-q', '-m', 'attrs');
  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  try {
    assert.equal(start(d).baseBranch, 'feature');
    write(d, 'a.bin', 'x');
    assert.ok(commitStep(d, { id: 's1', title: 't' }));
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.XDG !== undefined) process.env.XDG_CONFIG_HOME = saved.XDG;
  }
});

// ---------- symlink resolution ----------
test('a new link that climbs out through an existing in-repo link (dd/../file) is refused', () => {
  const d = repo('feature');
  start(d);
  const outside = mk('aa-outside-');
  fs.writeFileSync(path.join(outside, '..', `f-${path.basename(outside)}`), 'x');
  tmps.push(path.join(outside, '..', `f-${path.basename(outside)}`));
  fs.symlinkSync(path.join(outside, 'sub-not-there'), path.join(d, 'dd'));
  fs.mkdirSync(path.join(outside, 'sub-not-there'), { recursive: true });
  fs.symlinkSync(`dd/../f-${path.basename(outside)}`, path.join(d, 'ss'));
  refuses(() => commitStep(d, { id: 's1', title: 't' }), /symlink/);
  fs.rmSync(path.join(d, 'ss'));
  fs.symlinkSync('dd/../README.md', path.join(d, 'tt'));
  refuses(() => commitStep(d, { id: 's2', title: 't' }), /symlink/);
});

test('a symlink loop is refused', () => {
  const d = repo('feature');
  start(d);
  fs.symlinkSync('b', path.join(d, 'a'));
  fs.symlinkSync('a', path.join(d, 'b'));
  fs.symlinkSync('a/x', path.join(d, 'c'));
  refuses(() => commitStep(d, { id: 's1', title: 't' }), /symlink/);
});

// ---------- plain errors, allowlist ----------
test('assertNeverNetwork is an allowlist of the subcommands this module uses', () => {
  for (const sub of ['status', 'rev-parse', 'config', 'ls-files', 'switch', 'add', 'commit', 'diff', 'cat-file', 'reset']) assert.doesNotThrow(() => assertNeverNetwork(['git', '-c', 'a=b', sub]), sub);
  for (const sub of ['gc', 'worktree', 'am', 'apply', 'archive', 'bundle', 'filter-branch', 'checkout', 'stash', 'tag', 'update-ref']) assert.throws(() => assertNeverNetwork(['git', sub]), RunRefusal, sub);
  assert.throws(() => assertNeverNetwork(['git']), RunRefusal);
});

test('errors are plain: missing folder, non-repo, no absolute paths', () => {
  const missing = path.join(os.tmpdir(), 'aa-definitely-missing-dir');
  refuses(() => start(missing), /does not exist/);
  refuses(() => hasChanges(missing), /does not exist/);
  const plain = mk();
  refuses(() => commitStep(plain, { id: 'a', title: 'b' }), /not a git repository/);
  const d = repo('feature');
  g(d, 'branch', 'evil\u202e-x');
  refuses(() => diffSince(d, 'zzzz'), /not a commit id/);
});

test('addToExclude refuses a symlinked info/exclude and newline patterns', async () => {
  const { addToExclude } = await import('../skill/scripts/lib/git.js');
  const d = repo('feature');
  const target = path.join(mk('aa-tgt-'), 'x');
  fs.mkdirSync(path.join(d, '.git/info'), { recursive: true });
  fs.rmSync(path.join(d, '.git/info/exclude'), { force: true });
  fs.symlinkSync(target, path.join(d, '.git/info/exclude'));
  assert.throws(() => addToExclude(d, ['/a/']), /symlink/);
  assert.equal(fs.existsSync(target), false);
  fs.rmSync(path.join(d, '.git/info/exclude'));
  assert.throws(() => addToExclude(d, ['/a\n!b']), /one line/);
});

// ---------- round 2 ----------
test('a repo with a linked worktree can run in both checkouts', () => {
  const d = repo('feature');
  const wt = path.join(mk('aa-wt-'), 'wt');
  g(d, 'worktree', 'add', '-q', '-b', 'other', wt);
  fs.mkdirSync(path.join(wt, '.ai'));
  for (const [dir, name] of [[d, 'one'], [wt, 'two']]) {
    const r = start(dir, { now: new Date(NOW.getTime() + (name === 'two' ? 7000 : 0)) });
    assert.match(r.branch, /^android-architect\/run-/);
    assert.equal(hasChanges(dir), false);
    write(dir, `${name}.txt`);
    assert.equal(hasChanges(dir), true);
    assert.ok(commitStep(dir, { id: name, title: 't' }));
  }
});

test('a hostile config.worktree is refused once extensions.worktreeConfig is on, and ignored while it is off', () => {
  const d = repo('feature');
  write(d, '.git/config.worktree', '[filter "x"]\n\tclean = /bin/true\n');
  assert.equal(start(d).baseBranch, 'feature'); // git ignores the file, so does the scan
  const e = repo('feature');
  g(e, 'config', 'extensions.worktreeConfig', 'true');
  write(e, '.git/config.worktree', '[filter "x"]\n\tclean = /bin/true\n');
  refuses(() => start(e), /filter\.x\.clean/);
  const f = repo('feature');
  g(f, 'config', 'extensions.worktreeConfig', 'true');
  write(f, '.git/config.worktree', '[user]\n\tname = w\n');
  assert.equal(start(f).baseBranch, 'feature');
});

test('a staged symlink into the git folder is refused', () => {
  const d = repo('feature');
  start(d);
  fs.symlinkSync('.git/hooks', path.join(d, 'h1'));
  refuses(() => commitStep(d, { id: 's1', title: 't' }), /symlink/);
  fs.rmSync(path.join(d, 'h1'));
  fs.symlinkSync('./.git', path.join(d, 'h2'));
  refuses(() => commitStep(d, { id: 's2', title: 't' }), /symlink/);
});

test('a git failure inside confirmFirstUse becomes a RunRefusal', async () => {
  const d = repo('feature');
  cfgFile(d, '{"schemaVersion":1}');
  const config = loadRunConfig(d);
  fs.writeFileSync(path.join(d, '.git/index'), 'garbage');
  await assert.rejects(() => confirmFirstUse(d, { confirm: () => true, say: () => {}, config, agentArgv: ['claude'] }), (e) => e instanceof RunRefusal && !/\n\s+at /.test(e.message));
});

test('runGit does not spawn extra git processes per call (rev-parse results are cached)', () => {
  const bin = mk('aa-shim-');
  const log = path.join(bin, 'calls.log');
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const d = repo('feature');
  const oldPath = process.env.PATH;
  runGit(d, ['status', '--porcelain=v1']);
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    for (let i = 0; i < 5; i++) runGit(d, ['status', '--porcelain=v1']);
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 5);
});
