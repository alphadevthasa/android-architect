import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { headCommit, gitDir, addToExclude } from '../skill/scripts/lib/git.js';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-git-'));
const plain = path.join(tmp, 'plain');
const empty = path.join(tmp, 'empty');
const repo = path.join(tmp, 'repo');
const g = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'ignore',
  });

before(() => {
  for (const d of [plain, empty, repo]) fs.mkdirSync(d);
  if (!hasGit) return;
  g(empty, 'init');
  g(repo, 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  g(repo, 'add', '.');
  g(repo, 'commit', '-m', 'init');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('headCommit returns a 7-char short hash', { skip: !hasGit }, () => {
  assert.equal(headCommit(repo).length, 7);
});

test('headCommit and gitDir are null outside a repo', { skip: !hasGit }, () => {
  assert.equal(headCommit(plain), null);
  assert.equal(gitDir(plain), null);
});

test('headCommit is null in a repo without commits', { skip: !hasGit }, () => {
  assert.equal(headCommit(empty), null);
});

test('gitDir returns an absolute path', { skip: !hasGit }, () => {
  assert.ok(path.isAbsolute(gitDir(repo)));
});

test('addToExclude is idempotent', { skip: !hasGit }, () => {
  assert.deepEqual(addToExclude(repo, ['.ai/']), { added: ['.ai/'] });
  assert.deepEqual(addToExclude(repo, ['.ai/']), { added: [] });
  const text = fs.readFileSync(path.join(gitDir(repo), 'info', 'exclude'), 'utf8');
  assert.equal(text.split('\n').filter((l) => l === '.ai/').length, 1);
});

test('addToExclude throws outside a repo', { skip: !hasGit }, () => {
  assert.throws(() => addToExclude(plain, ['.ai/']), /--local needs a git repository/);
});

test('addToExclude in a linked worktree writes to the common git dir', { skip: !hasGit }, () => {
  const wt = path.join(tmp, 'wt');
  g(repo, 'worktree', 'add', wt, '-b', 'wt-branch');
  assert.deepEqual(addToExclude(wt, ['CLAUDE.local.md']), { added: ['CLAUDE.local.md'] });
  const common = path.join(repo, '.git', 'info', 'exclude');
  assert.match(fs.readFileSync(common, 'utf8'), /^CLAUDE\.local\.md$/m);
  fs.writeFileSync(path.join(wt, 'CLAUDE.local.md'), 'x');
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' });
  assert.equal(status, '');
});
