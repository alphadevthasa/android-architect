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

/** Absolute git dir of the repo containing root, or null. */
export function gitDir(root) {
  return git(root, ['rev-parse', '--absolute-git-dir']) || null;
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
