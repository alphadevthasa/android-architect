// Safety checks of the run loop that look at the machine instead of at model output: the .ai/STOP file, the lock that
// keeps two runs from working on one repository, and a digest of the files an agent must not touch (run config, plan,
// roadmap, git settings, hooks, HEAD). Everything is lstat based (nothing follows a symlink), bounded and plain.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RunRefusal, isSecretName } from './rungit.js';
import { parseRoadmap } from './runplan.js';

const posix = (p) => p.split(path.sep).join('/');

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
      if (!holds()) throw new RunRefusal('another run is starting in this repository; try again');
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
    // stale: its process is gone. Remove only the very lock that was judged stale (another run may have replaced it).
    try {
      const again = readLock(file);
      if (again.bad ? info.bad : again.token === info.token) fs.rmSync(file, { force: true });
    } catch {
      // vanished: try again
    }
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
  const tops = new Set([root, readGit(git, root, ['rev-parse', '--show-toplevel']) || root]);
  for (const t of tops) for (const f of ['.gitignore', '.gitattributes', '.gitmodules']) gitParts.push(`${t}/${f}=${fileDigest(path.join(t, f))}`);
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

// ---------- build-code gate ----------
// Verification runs the project's build code (Gradle wrapper, build scripts, package scripts) as the user. When the
// agent changed any file that can execute during a build, a human must look at it first.
const BUILD_NAMES = new Set(['gradlew', 'gradlew.bat', 'gradle.properties', 'package.json', '.npmrc', 'makefile']);

/** True when a repo-relative path can run code during verification. Case-insensitive (macOS/Windows fold names). */
export function isBuildPath(p, verifyScripts = new Set()) {
  const low = String(p).toLowerCase().split('\\').join('/');
  const segs = low.split('/').filter(Boolean);
  const base = segs[segs.length - 1] ?? '';
  if (BUILD_NAMES.has(base) || base.endsWith('.gradle') || base.endsWith('.gradle.kts') || base.endsWith('.sh') || base.startsWith('settings.gradle')) return true;
  if (segs.includes('buildsrc')) return true;
  for (let i = 0; i + 1 < segs.length; i++) if (segs[i] === 'gradle' && segs[i + 1] === 'wrapper') return true;
  const rel = segs.join('/');
  for (const sc of verifyScripts) if (rel === sc || rel.endsWith(`/${sc}`)) return true;
  return false;
}

/** Normalized (lowercase, no leading ./) arguments of the verification commands: scripts they name are build code. */
export function verificationScripts(config) {
  const out = new Set();
  for (const argv of config?.verification?.commands ?? []) {
    for (const a of argv.slice(1)) {
      const n = String(a).toLowerCase().split('\\').join('/').replace(/^(\.\/)+/, '');
      if (n !== '' && !n.startsWith('-')) out.add(n);
    }
  }
  return out;
}

/** Changed and untracked repo-relative paths (read-only `git status -z`, every untracked file listed). */
export function changedPaths(git, root) {
  const out = git.runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  const paths = [];
  for (const rec of out.split('\0')) {
    if (rec.length > 3 && rec[2] === ' ') paths.push(rec.slice(3));
  }
  return paths;
}

/**
 * The gate: null when no changed/untracked/deleted path is build code, or when `approved` (array of hashes) holds the exact
 * approval hash; else { files (sorted repo-relative names), count, hash }. hash = sha256 over the sorted
 * (path, content digest) pairs, so any later edit of those files invalidates an approval. A symlink is digested by its
 * target text, a deleted file as "absent".
 */
export function buildGate(git, root, config, approved = []) {
  const top = readGit(git, root, ['rev-parse', '--show-toplevel']) || root;
  const scripts = verificationScripts(config);
  const prefix = path.relative(top, root);
  const files = [...new Set(changedPaths(git, root))].filter((p) => {
    // a path inside the project is also compared by its project-relative name (scripts named in the verification argv)
    const inner = prefix && posix(p).startsWith(`${posix(prefix)}/`) ? posix(p).slice(posix(prefix).length + 1) : posix(p);
    return isBuildPath(p, scripts) || isBuildPath(inner, scripts);
  }).sort();
  if (files.length === 0) return null;
  const hash = crypto.createHash('sha256').update(files.map((f) => `${f}\0${fileDigest(path.join(top, f))}`).join('\n')).digest('hex');
  if (Array.isArray(approved) && approved.includes(hash)) return null;
  return { files, count: files.length, hash };
}

// ---------- verify-only resume checks (ruling 19) ----------
const PROTECTED_DIRTY = ['.ai/run.config.json', '.ai/migration/plan.json', '.ai/stop'];
const AI_OK = new Set(['.ai/migration/roadmap.md']);

/**
 * Checks of a dirty tree that is about to be verified without an agent run. Returns null, or { outcome, reason }:
 * refused when protected files (run config, plan, STOP, .gitignore/.gitattributes/.gitmodules) or the roadmap rows of
 * other steps differ from HEAD; needs-human when secret-looking names or other .ai files are among the changes.
 */
export function resumeChecks(git, root, stepId) {
  const top = readGit(git, root, ['rev-parse', '--show-toplevel']) || root;
  const prefix = posix(path.relative(top, root));
  const rel = (p) => (prefix && posix(p).startsWith(`${prefix}/`) ? posix(p).slice(prefix.length + 1) : posix(p));
  const paths = [...new Set(changedPaths(git, root))];
  const prot = paths.filter((p) => {
    const r = rel(p).toLowerCase();
    const base = r.split('/').pop();
    return PROTECTED_DIRTY.includes(r) || base === '.gitignore' || base === '.gitattributes' || base === '.gitmodules';
  });
  if (prot.length > 0) return { outcome: 'refused', reason: `${prot.length} protected file(s) are modified in the working tree; commit or revert them before resuming` };
  const sensitive = paths.filter((p) => {
    const r = rel(p).toLowerCase();
    return isSecretName(p) || (r.startsWith('.ai/') && !r.startsWith('.ai/runs/') && !AI_OK.has(r));
  });
  if (sensitive.length > 0) return { outcome: 'needs-human', reason: `${sensitive.length} file(s) that look like secrets or runner state are in the working tree; remove them before resuming` };
  // roadmap: only this step's row may differ from HEAD
  try {
    const now = parseRoadmap(fs.readFileSync(path.join(root, '.ai/migration/roadmap.md'), 'utf8')).steps;
    const head = parseRoadmap(git.runGit(root, ['cat-file', 'blob', 'HEAD:./.ai/migration/roadmap.md'])).steps;
    const was = new Map(head.map((s) => [s.id, s.status]));
    if (now.some((s) => s.id !== stepId && was.get(s.id) !== s.status) || now.length !== head.length) return { outcome: 'refused', reason: 'the roadmap status of other steps differs from the last commit; commit or revert it before resuming' };
  } catch {
    return { outcome: 'refused', reason: 'the roadmap cannot be compared with the last commit' };
  }
  return null;
}
