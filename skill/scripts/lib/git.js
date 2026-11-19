import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
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
      { cwd: root, stdio: 'ignore' },
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

/**
 * Subset of relPaths (relative to root, POSIX) that git ignores, via one `git check-ignore --stdin` process.
 * Tracked files are not reported as ignored. Not a repo, git missing, or none ignored gives an empty set.
 */
export function ignoredPaths(root, relPaths) {
  if (relPaths.length === 0) return new Set();
  let out = '';
  try {
    out = execFileSync('git', ['check-ignore', '-z', '--stdin'], {
      cwd: root,
      input: relPaths.join('\0'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return new Set(); // exit 1 = none ignored; other failures = no usable git
  }
  return new Set(out.split('\0').filter(Boolean));
}
