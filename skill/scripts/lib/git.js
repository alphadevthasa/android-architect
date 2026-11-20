import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Stable English git messages regardless of the user's locale.
function gitEnv() {
  return { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' };
}

function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/** Short (7 char) HEAD commit, or null when git is missing, not a repo, or no commits. */
export function headCommit(root) {
  return git(root, ['rev-parse', '--short=7', 'HEAD']) || null;
}

const SHA = /^[0-9a-f]{4,40}$/;

/**
 * True when files under root (minus the `exclude` pathspecs, relative to root) differ between `commit` and HEAD.
 * An unknown, unreachable or malformed commit, or no git, counts as changed.
 */
export function changedSince(root, commit, exclude = []) {
  if (typeof commit !== 'string' || !SHA.test(commit)) return true;
  try {
    execFileSync(
      'git',
      ['diff', '--quiet', '--no-ext-diff', '--no-textconv', commit, 'HEAD', '--', '.', ...exclude.map((p) => `:(exclude)${p}`)],
      { cwd: root, env: gitEnv(), stdio: 'ignore' },
    );
    return false;
  } catch {
    return true;
  }
}

/** Absolute git dir of the repo containing root, or null. */
export function gitDir(root) {
  return git(root, ['rev-parse', '--absolute-git-dir']) || null;
}

/** Absolute top-level directory of the working tree containing root, or null. */
export function topLevel(root) {
  return git(root, ['rev-parse', '--show-toplevel']) || null;
}

/** Absolute common git dir (shared by linked worktrees), or null. */
function commonGitDir(root) {
  const out = git(root, ['rev-parse', '--git-common-dir']);
  return out ? path.resolve(root, out) : null;
}

/** Append missing lines to <commonGitDir>/info/exclude (works in linked worktrees). Idempotent. */
export function addToExclude(root, patterns) {
  const dir = commonGitDir(root);
  if (!dir) throw new Error('--local needs a git repository');
  const file = path.join(dir, 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/));
  const added = patterns.filter((p) => !have.has(p));
  if (added.length > 0) {
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(file, existing + sep + added.join('\n') + '\n');
  }
  return { added };
}

function insideGitTree(root) {
  let dir = path.resolve(root);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/**
 * Subset of relPaths (relative to root, POSIX) that git ignores, via one `git check-ignore --stdin` process.
 * Tracked files are not reported as ignored. Fails closed: inside a git repo any git error other than
 * "none ignored" (exit 1) throws. Only a missing git or a directory outside any repo gives an empty set.
 */
export function ignoredPaths(root, relPaths) {
  if (relPaths.length === 0) return new Set();
  let out = '';
  try {
    out = execFileSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd: root,
      env: gitEnv(),
      input: relPaths.join('\0'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === 'ENOENT' || err.status === 1) return new Set();
    const stderr = String(err.stderr ?? '');
    if (/not a git repository/i.test(stderr) && !insideGitTree(root)) return new Set();
    const first = stderr.split(/\r?\n/).find((l) => l.trim() !== '') ?? err.message.split('\n')[0];
    let hint = '';
    if (/dubious ownership/i.test(stderr)) {
      const repo = /dubious ownership in repository at '([^'\n]+)'/i.exec(stderr)?.[1] ?? path.resolve(root);
      hint = ` (if this is a container or shared checkout, run: git config --global --add safe.directory ${repo})`;
    }
    throw new Error('could not determine git-ignored files: ' + first + hint);
  }
  return new Set(out.split('\0').filter(Boolean));
}

/**
 * Files touched by each commit of the last `sinceMonths` months, as [{ files: string[] }] (paths relative to root,
 * POSIX), from one `git log` call. Advisory data, not a security filter: returns null (never throws) when git is
 * missing, root is not a repo, there are no commits, the clone is shallow with fewer than 2 commits, or git fails.
 */
export function churnByCommit(root, { sinceMonths = 6 } = {}) {
  try {
    if (headCommit(root) === null) return null;
    const count = Number.parseInt(git(root, ['rev-list', '--count', 'HEAD']) ?? '', 10);
    if (!Number.isFinite(count) || count < 1) return null;
    if (git(root, ['rev-parse', '--is-shallow-repository']) === 'true' && count < 2) return null;
    const months = Number.isInteger(sinceMonths) && sinceMonths > 0 ? sinceMonths : 6;
    const out = execFileSync(
      'git',
      ['log', '--relative', '--no-renames', `--since=${months}.months`, '--name-only', '-z', '--pretty=format:%x01'],
      { cwd: root, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const commits = [];
    for (const chunk of out.split('\x01').slice(1)) {
      const files = [...new Set(chunk.replace(/^\n/, '').split('\0').filter((f) => f !== ''))];
      commits.push({ files });
    }
    return commits;
  } catch {
    return null;
  }
}
