// Safety checks of the run loop that look at the machine instead of at model output: the .ai/STOP file, the lock that
// keeps two runs from working on one repository, and a digest of the files an agent must not touch (run config, plan,
// roadmap, git settings, hooks, HEAD). Everything is lstat based (nothing follows a symlink), bounded and plain.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RunRefusal } from './rungit.js';

export const STOP_FILE = '.ai/STOP';
const MAX_DIGEST_BYTES = 16 * 1024 * 1024;
const MAX_HOOKS = 200;
const LOCK_DIR = 'android-architect';
const LOCK_NAME = 'run.lock';
const MAX_LOCK_BYTES = 1024;

/**
 * True when .ai/STOP exists as ANY kind of entry (file, directory, symlink, FIFO: lstat, never followed) or cannot be
 * checked for a reason other than "it is not there". Failing closed is deliberate: unknown means stop.
 */
export function stopPresent(root) {
  try {
    if (fs.lstatSync(path.join(root, '.ai')).isSymbolicLink()) return true;
    fs.lstatSync(path.join(root, STOP_FILE));
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

// ---------- lock ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when a process with this id exists (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function gitCommon(git, root) {
  let out;
  try {
    out = git.runGit(root, ['rev-parse', '--git-common-dir']).trim();
  } catch {
    throw new RunRefusal('this is not a git repository');
  }
  return path.resolve(root, out);
}

function lockDir(common) {
  const dir = path.join(common, LOCK_DIR);
  let st = null;
  try {
    st = fs.lstatSync(dir);
  } catch {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      st = fs.lstatSync(dir);
    } catch {
      throw new RunRefusal('cannot create the run lock folder in the git folder');
    }
  }
  if (!st.isDirectory()) throw new RunRefusal('the run lock folder in the git folder is not a directory');
  return dir;
}

function readLock(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.size > MAX_LOCK_BYTES) return { bad: true };
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && Number.isSafeInteger(v.pid) && v.pid > 0 && typeof v.token === 'string') return { pid: v.pid, token: v.token };
  } catch {
    // unparseable: handled by the caller
  }
  return { bad: true, ageMs: Date.now() - st.mtimeMs };
}

/**
 * Takes the run lock: <git common dir>/android-architect/run.lock, created exclusively (O_EXCL, so a planted symlink
 * fails) with { pid, token }. A second run refuses with a plain message while the pid in the lock is alive. A lock
 * whose pid is gone (a crashed run) is stale and is taken over. Limits, by design: the pid check is only as good as
 * pid reuse allows (a recycled pid keeps a stale lock alive until that process ends; delete
 * <git dir>/android-architect/run.lock by hand if you are sure no run is active) and the lock is per machine, not per
 * network share. holds() re-reads the file and is true only while it still carries this run's token, so a run whose
 * lock was taken over (a stale-takeover race) notices and stops.
 * Returns { release(), holds() }.
 */
export async function acquireLock(git, root, { pid = process.pid, alive = pidAlive } = {}) {
  const dir = lockDir(gitCommon(git, root));
  const file = path.join(dir, LOCK_NAME);
  const token = crypto.randomBytes(8).toString('hex');
  const body = `${JSON.stringify({ schemaVersion: 1, pid, token, startedAt: new Date().toISOString() })}\n`;
  const holds = () => {
    try {
      return readLock(file).token === token;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
      return {
        holds,
        release() {
          if (holds()) fs.rmSync(file, { force: true });
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw new RunRefusal('cannot create the run lock in the git folder');
    }
    let info;
    try {
      info = readLock(file);
    } catch {
      continue; // vanished between the two calls: try again
    }
    if (info.bad) {
      if (info.ageMs !== undefined && info.ageMs < 2000) {
        await sleep(150); // a run that is still writing its lock
        continue;
      }
      if (info.ageMs === undefined) throw new RunRefusal('the run lock in the git folder is not usable (not a small regular file): remove it by hand');
    } else if (alive(info.pid)) {
      throw new RunRefusal(`another run is active in this repository (process ${info.pid}); wait for it to finish`);
    }
    fs.rmSync(file, { force: true }); // stale: its process is gone
  }
  throw new RunRefusal('another run is starting in this repository; try again');
}

// ---------- digest of the files an agent must not touch ----------
function fileDigest(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    return err.code === 'ENOENT' ? 'absent' : `error:${err.code ?? 'x'}`;
  }
  if (st.isSymbolicLink()) {
    try {
      return `link:${fs.readlinkSync(abs)}`;
    } catch {
      return 'link:?';
    }
  }
  if (st.isDirectory()) return 'dir';
  if (!st.isFile()) return `special:${st.mode}`;
  if (st.size > MAX_DIGEST_BYTES) return `big:${st.size}`;
  try {
    return `file:${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`;
  } catch {
    return 'unreadable';
  }
}

function dirDigest(abs) {
  let names;
  try {
    names = fs.readdirSync(abs).sort();
  } catch {
    return 'absent';
  }
  return names.slice(0, MAX_HOOKS).map((n) => `${n}=${fileDigest(path.join(abs, n))}`).join(';') + (names.length > MAX_HOOKS ? `;+${names.length}` : '');
}

const combine = (parts) => crypto.createHash('sha256').update(parts.join('\n')).digest('hex');

/** Output of a git read call, or '' when git fails (HEAD may be unborn after a tamper). */
function readGit(git, root, args) {
  try {
    return git.runGit(root, args).trim();
  } catch {
    return '';
  }
}

export const SNAPSHOT_LABELS = Object.freeze({ config: 'the run config', plan: 'the migration plan or roadmap', git: 'git settings, hooks or HEAD' });

/**
 * Digest of everything the agent must leave alone, by category: `config` (.ai/run.config.json), `plan`
 * (.ai/migration/plan.json and roadmap.md, every byte), `git` (HEAD commit and branch, the .git entry, config,
 * config.worktree, info/exclude, info/attributes, hooks, and the consent file in the git folder). .ai/STOP is not
 * in it: its mere presence stops the run (stopPresent), whoever created it.
 */
export function takeSnapshot(git, root) {
  const gitDir = readGit(git, root, ['rev-parse', '--absolute-git-dir']);
  const common = path.resolve(root, readGit(git, root, ['rev-parse', '--git-common-dir']) || '.git');
  const gitParts = [
    `head=${readGit(git, root, ['rev-parse', 'HEAD'])}`,
    `ref=${readGit(git, root, ['symbolic-ref', '-q', 'HEAD'])}`,
    `entry=${fileDigest(path.join(root, '.git'))}`,
  ];
  for (const d of new Set([gitDir || common, common])) {
    for (const f of ['HEAD', 'config', 'config.worktree', 'commondir', 'gitdir', 'info/exclude', 'info/attributes']) gitParts.push(`${d}/${f}=${fileDigest(path.join(d, f))}`);
    gitParts.push(`${d}/hooks=${dirDigest(path.join(d, 'hooks'))}`);
  }
  gitParts.push(`consent=${dirDigest(path.join(common, 'android-architect')).split(';').filter((x) => !x.startsWith(`${LOCK_NAME}=`)).join(';')}`);
  return {
    config: combine([fileDigest(path.join(root, '.ai/run.config.json'))]),
    plan: combine([fileDigest(path.join(root, '.ai/migration/plan.json')), fileDigest(path.join(root, '.ai/migration/roadmap.md'))]),
    git: combine(gitParts),
  };
}

/** Plain labels of the categories that differ between two snapshots (empty when nothing changed). */
export function diffSnapshots(before, after) {
  return Object.keys(SNAPSHOT_LABELS).filter((k) => before[k] !== after[k]).map((k) => SNAPSHOT_LABELS[k]);
}
