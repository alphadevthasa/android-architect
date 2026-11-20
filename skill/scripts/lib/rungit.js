// Git safety for the autonomous run loop. This file holds the ONLY place the runner spawns git (runGit) and the
// run-branch, commit, diff and first-use confirmation logic built on it. Inputs that an attacker may control are the
// repository (files, symlinks, .gitattributes), .ai/run.config.json and anything printed by an agent or a build, so:
// no shell, argv arrays only, a hardened git invocation, no network subcommand ever, strict path checks before a
// commit, and consent bound to the exact config bytes and agent argv.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cleanGitEnv, addToExclude } from './git.js';
import { redact } from './redact.js';
import { stripUnsafe } from './mdtext.js';
import { oneLine } from './overrides.js';
import { RUN_CONFIG_FILE, DEFAULT_RUN_CONFIG, validateRunConfig } from './runconfig.js';

/** An expected refusal: the message is plain text (no stack, no absolute paths) and safe to print. */
export class RunRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunRefusal';
  }
}

/** Text safe to print or store in a one-line message: no control or bidi characters, redacted, capped. */
export function plainText(s, max = 200) {
  const t = oneLine(stripUnsafe(String(s)).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '));
  const r = redact(t).text;
  return r.length > max ? `${r.slice(0, max - 3)}...` : r;
}

const DEFAULT_BRANCHES = ['main', 'master', 'trunk', 'develop'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const RUNS_DIR = '.ai/runs';
const CONSENT_DIR = 'android-architect';
const CONSENT_NAME = 'confirmed.json';
const MAX_CONSENT_BYTES = 4096;
const MAX_CONFIG_BYTES = 64 * 1024;

// ---------- the network guard ----------
const FORBIDDEN_GIT = new Set(['push', 'fetch', 'pull', 'clone', 'remote', 'merge', 'rebase', 'submodule', 'ls-remote', 'request-pull', 'send-email', 'daemon', 'instaweb']);
// The only git subcommands this module uses: anything else is refused, whatever the caller meant.
const ALLOWED_GIT = new Set(['status', 'rev-parse', 'symbolic-ref', 'config', 'ls-files', 'switch', 'add', 'commit', 'diff', 'cat-file', 'show-ref', 'check-ref-format', 'check-ignore', 'var', 'reset']);
const FORBIDDEN_OPTION_PREFIXES = ['--upload-pack', '--receive-pack', '--exec'];
const FORBIDDEN_EXES = new Set(['curl', 'wget', 'ssh', 'scp', 'nc', 'ncat', 'telnet', 'ftp']);

/** The git subcommand of an args list (skips global options and the value of -c / -C). */
function subcommandOf(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return 'git';
}

/**
 * Throws RunRefusal unless `argv` (with or without a leading `git`) is a git call this module makes: the subcommand
 * must be on the allowlist, no element may be exactly a network or history-merging subcommand (compared
 * case-insensitively, wherever it appears, so global options in front cannot hide one), no option may start with
 * --upload-pack, --receive-pack or --exec, and executables such as curl, wget, ssh, scp, nc or `npm publish` are refused.
 */
export function assertNeverNetwork(argv) {
  const list = argv.map((a) => String(a));
  const exe = (list[0] ?? '').split(/[\\/]/).pop().toLowerCase();
  if (FORBIDDEN_EXES.has(exe)) throw new RunRefusal(`the runner never runs ${exe}`);
  if (exe === 'npm' && list.some((a) => a.toLowerCase() === 'publish')) throw new RunRefusal('the runner never publishes');
  for (const a of list) {
    const low = a.toLowerCase();
    if (FORBIDDEN_GIT.has(low)) throw new RunRefusal(`the runner never runs git ${low}`);
    if (FORBIDDEN_OPTION_PREFIXES.some((p) => low.startsWith(p))) throw new RunRefusal('the runner never passes a network option to git');
  }
  const args = exe === 'git' ? list.slice(1) : list;
  if (!ALLOWED_GIT.has(subcommandOf(args))) throw new RunRefusal('the runner does not run this git command');
}

// ---------- the single git wrapper ----------
// Defense in depth, applied to every invocation. Repo-local config (.git/config) can run programs (core.fsmonitor,
// core.sshCommand, alias.*, diff.external, hooks); the rest of the list keeps git from prompting, paging, signing,
// running maintenance in the background or speaking any transport.
const HARDENING = [
  '--no-pager',
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.pager=cat',
  '-c', 'protocol.allow=never',
  '-c', 'diff.external=',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.attributesFile=/dev/null',
];

class GitFailure extends Error {
  constructor(sub, status) {
    super(`git ${sub} failed`);
    this.name = 'GitFailure';
    this.status = status;
  }
}

function rawGit(root, args, { input, extra = [] } = {}) {
  assertNeverNetwork(['git', ...args]);
  const env = cleanGitEnv({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
  try {
    return execFileSync('git', [...HARDENING, ...extra, ...args], {
      cwd: root,
      env,
      input,
      encoding: 'utf8',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === 'ENOENT' && !fs.existsSync(root)) throw new RunRefusal('the project folder does not exist');
    if (err.code === 'ENOENT') throw new RunRefusal('git is not available');
    throw new GitFailure(subcommandOf(args), typeof err.status === 'number' ? err.status : null);
  }
}

// ---------- repo-local config that can run programs ----------
// Clean/smudge/process filters, merge/diff drivers, fsmonitor, pager, editor and ssh commands named in the REPO-LOCAL
// (or worktree) config execute programs during plain status/add. A PR cannot ship .git/config, but a repo prepared by
// someone else may carry one, so such a repo is refused. The user's own global config (git-lfs) stays trusted.
const sigOf = (file) => {
  try {
    const st = fs.lstatSync(file);
    return `${st.size}:${st.mtimeMs}:${st.isSymbolicLink() ? 'l' : 'f'}`;
  } catch {
    return '-';
  }
};

function splitKey(key) {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  return { section: key.slice(0, first).toLowerCase(), sub: first === last ? '' : key.slice(first + 1, last), name: key.slice(last + 1).toLowerCase() };
}

function dangerousKey(key) {
  const { section, name } = splitKey(key);
  if (section === 'filter' || section === 'include' || section === 'includeif') return true;
  if (section === 'merge' && name === 'driver') return true;
  if (section === 'diff' && (name === 'command' || name === 'textconv' || name === 'external')) return true;
  if (section === 'core' && ['worktree', 'fsmonitor', 'sshcommand', 'pager', 'editor', 'attributesfile'].includes(name)) return true;
  return false;
}

const configCache = new Map();

/** { problem: string|null, filters: string[] } for the repo-local and worktree config of the repo at `common`. */
function scanLocalConfig(root, gitDir, common) {
  const files = [path.join(common, 'config'), path.join(gitDir, 'config.worktree'), path.join(common, 'info', 'attributes')];
  const sig = files.map(sigOf).join('|');
  const cached = configCache.get(common);
  if (cached && cached.sig === sig) return cached.result;
  const result = { problem: null, filters: [] };
  // `git config --worktree` fails (exit 128) in a repo with linked worktrees unless extensions.worktreeConfig is set, and
  // git ignores config.worktree unless it is set: scan that scope only when the local config enables it.
  let worktreeConfig = false;
  for (const scope of ['--local', '--worktree']) {
    if (scope === '--worktree' && !worktreeConfig) continue;
    let out;
    try {
      out = rawGit(root, ['config', scope, '--list', '-z', '--no-includes']);
    } catch {
      result.problem = 'cannot read the repository git config; refusing to continue';
      break;
    }
    for (const entry of out.split('\0')) {
      if (!entry) continue;
      const nl = entry.indexOf('\n');
      const key = nl < 0 ? entry : entry.slice(0, nl);
      const value = nl < 0 ? '' : entry.slice(nl + 1);
      if (scope === '--local' && key.toLowerCase() === 'extensions.worktreeconfig' && ['true', 'yes', 'on', '1', ''].includes(value.toLowerCase())) worktreeConfig = true;
      const { section, sub } = splitKey(key);
      if (section === 'filter' && /^[A-Za-z0-9._-]{1,100}$/.test(sub) && !result.filters.includes(sub)) result.filters.push(sub);
      if (result.problem === null && dangerousKey(key)) {
        result.problem = `the repository git config defines "${plainText(key, 60)}", which can run programs: remove it, or run the steps by hand`;
      }
    }
  }
  try {
    const st = fs.lstatSync(files[2]);
    if (result.problem === null && (st.isSymbolicLink() || st.size > 0)) result.problem = 'the repository has a .git/info/attributes file, which can enable filters: remove it, or run the steps by hand';
  } catch {
    // no attributes file
  }
  configCache.set(common, { sig, result });
  return result;
}

const dirsCache = new Map();

/** Extra -c arguments neutralizing every repo-local filter name (defense in depth next to the refusal). */
function filterOverrides(root) {
  let dirs = dirsCache.get(root);
  if (!dirs) {
    try {
      dirs = {
        common: path.resolve(root, rawGit(root, ['rev-parse', '--git-common-dir']).replace(/\n$/, '')),
        gitDir: path.resolve(root, rawGit(root, ['rev-parse', '--git-dir']).replace(/\n$/, '')),
      };
    } catch {
      return [];
    }
    dirsCache.set(root, dirs);
  }
  const { filters } = scanLocalConfig(root, dirs.gitDir, dirs.common);
  return filters.flatMap((n) => ['-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`]);
}

/**
 * Runs `git <args>` in `root` and returns stdout (utf8, untrimmed). Every call goes through assertNeverNetwork first
 * and carries the hardening list plus empty overrides for every repo-local filter.
 * Throws GitFailure (message "git <subcommand> failed", `status` = exit code or null) on a non-zero exit.
 */
export function runGit(root, args, { input } = {}) {
  assertNeverNetwork(['git', ...args]);
  return rawGit(root, args, { input, extra: filterOverrides(root) });
}

/** Trimmed stdout, or null when git exits non-zero. */
function tryGit(root, args) {
  try {
    return runGit(root, args).trim();
  } catch (err) {
    if (err instanceof GitFailure) return null;
    throw err;
  }
}

// ---------- repository facts ----------
/** Converts a git failure into a plain refusal. */
function plainErrors(fn) {
  const convert = (err) => {
    if (err instanceof GitFailure) throw new RunRefusal(err.message);
    if (err instanceof RunRefusal) throw err;
    if (err && typeof err.code === 'string' && err.syscall) throw new RunRefusal(`a file operation failed (${err.code})`);
    throw err;
  };
  return (...a) => {
    try {
      const r = fn(...a);
      return r && typeof r.then === 'function' ? r.catch(convert) : r;
    } catch (err) {
      return convert(err);
    }
  };
}

/**
 * Facts about the repository containing root, after checking that root is the working tree git thinks it is and that
 * the repo-local config cannot run programs. Nothing that could run a filter happens before this returns.
 */
function repoInfo(root) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    throw new RunRefusal('the project folder does not exist');
  }
  let top;
  let prefix;
  let gitDir;
  let common;
  try {
    top = rawGit(realRoot, ['rev-parse', '--show-toplevel']).trim();
    prefix = rawGit(realRoot, ['rev-parse', '--show-prefix']).replace(/\n$/, '');
    gitDir = path.resolve(realRoot, rawGit(realRoot, ['rev-parse', '--git-dir']).replace(/\n$/, ''));
    common = path.resolve(realRoot, rawGit(realRoot, ['rev-parse', '--git-common-dir']).replace(/\n$/, ''));
  } catch (err) {
    if (err instanceof RunRefusal) throw err;
    throw new RunRefusal('not a git repository: the runner needs a git repository with at least one commit');
  }
  let realTop;
  try {
    realTop = fs.realpathSync(top);
    if (fs.realpathSync(path.join(realTop, prefix)) !== realRoot) throw new Error('mismatch');
  } catch {
    throw new RunRefusal('the project folder is not the working tree git reports (core.worktree or a redirected repository)');
  }
  if (prefix.includes('\n') || prefix.includes('\r')) throw new RunRefusal('the project path contains a newline');
  dirsCache.set(realRoot, { common, gitDir });
  const { problem } = scanLocalConfig(realRoot, gitDir, common);
  if (problem) throw new RunRefusal(problem);
  return { top: realTop, prefix, common, gitDir, root: realRoot };
}

const isRuns = (p, prefix) => {
  const low = p.toLowerCase();
  const runs = `${prefix}${RUNS_DIR}`.toLowerCase();
  return low === runs || low.startsWith(`${runs}/`);
};

/** [{ xy, path, orig }] of `git status`, repo-relative; any failure refuses (submodule, LFS, sparse: be conservative). */
function statusEntries(root) {
  let out;
  try {
    out = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  } catch (err) {
    if (err instanceof RunRefusal) throw err;
    throw new RunRefusal('cannot read the git status; refusing to continue');
  }
  const tokens = out.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    const xy = t.slice(0, 2);
    const entry = { xy, path: t.slice(3), orig: null };
    if (xy.includes('R') || xy.includes('C')) entry.orig = tokens[++i] ?? null;
    entries.push(entry);
  }
  return entries;
}

/** Status entries outside .ai/runs/ and outside `ignore` (paths relative to the project root). */
function dirtyEntries(root, prefix, ignore = []) {
  const skip = new Set(ignore.map((p) => `${prefix}${p}`));
  return statusEntries(root).filter((e) => !isRuns(e.path, prefix) && !skip.has(e.path) && !(e.orig !== null && skip.has(e.orig)));
}

/** Refuses when git tracks .ai or anything in .ai/runs (any letter case: case-insensitive file systems fold names). */
function refuseTrackedRuns(root) {
  const tracked = runGit(root, ['ls-files', '-z', '--', ':(icase).ai']);
  for (const p of tracked.split('\0')) {
    if (!p) continue;
    const low = p.toLowerCase();
    if (low === '.ai' || low === RUNS_DIR || low.startsWith(`${RUNS_DIR}/`)) {
      throw new RunRefusal('.ai/runs/ (or .ai itself) is tracked by git; the runner logs are local only: remove it from git first (git rm --cached)');
    }
  }
}

/** Adds the anchored `/<project prefix>.ai/runs/` line to .git/info/exclude. */
function excludeRunLogs(info) {
  const escaped = `${info.prefix}${RUNS_DIR}/`.replace(/[\\*?[\]]/g, '\\$&');
  try {
    addToExclude(info.root, [`/${escaped}`], { commonDir: info.common });
  } catch {
    throw new RunRefusal('cannot update .git/info/exclude');
  }
}

/** Branch name from `refs/remotes/origin/HEAD`, or null. */
function originHeadBranch(root) {
  const ref = tryGit(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  const lead = 'refs/remotes/origin/';
  return ref && ref.startsWith(lead) ? ref.slice(lead.length) : null;
}

const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;
const stamp = (d) => {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

/**
 * Prepares the branch the run works on and returns { branch, baseBranch, baseCommit, resumed }.
 * Refuses (RunRefusal, nothing changed) when: not a repository, the repo-local git config can run programs (filters,
 * drivers, fsmonitor, core.worktree ...), no commits, detached HEAD, the current branch is a default branch (target of
 * refs/remotes/origin/HEAD, else main/master/trunk/develop; a custom default name without origin/HEAD is detectable
 * only through `protectedBranches` from run.config.json), the tree is not clean (untracked files count; .ai/runs/ does
 * not), .ai or .ai/runs is tracked, or .git/info/exclude cannot be updated.
 * On a branch named `<branchPrefix>-...` the run resumes: nothing new is created and baseBranch is null.
 * `resumeDirtyOk` lists project-relative paths (the roadmap) that may be dirty on resume: a stopped run leaves its
 * `doing` row uncommitted on purpose.
 */
export const startRunBranch = plainErrors((root, { branchPrefix, now, protectedBranches = [], resumeDirtyOk = [] } = {}) => {
  const info = repoInfo(root);
  const { prefix } = info;
  root = info.root;
  if (typeof branchPrefix !== 'string' || !SAFE_BRANCH.test(branchPrefix) || branchPrefix.startsWith('-') || branchPrefix.includes('..')) {
    throw new RunRefusal('the branch prefix is not a safe branch name');
  }
  const head = tryGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!head) throw new RunRefusal('the repository has no commits yet: make an initial commit first');
  const ref = tryGit(root, ['symbolic-ref', '-q', 'HEAD']);
  if (!ref) throw new RunRefusal('detached HEAD: check out a feature branch first');
  const current = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  const defaults = new Set([...DEFAULT_BRANCHES, ...protectedBranches]);
  const originHead = originHeadBranch(root);
  if (originHead) defaults.add(originHead);
  if (defaults.has(current)) throw new RunRefusal(`the current branch "${plainText(current, 80)}" is a default branch: check out a feature branch first`);
  refuseTrackedRuns(root);
  const resumed = current.startsWith(`${branchPrefix}-`);
  if (dirtyEntries(root, prefix, resumed ? resumeDirtyOk : []).length > 0) {
    throw new RunRefusal('the working tree is not clean (uncommitted or untracked files): commit or stash them first');
  }
  if (resumed) {
    excludeRunLogs(info);
    return { branch: current, baseBranch: null, baseCommit: head, resumed: true };
  }
  const d = new Date(now ?? Date.now());
  if (Number.isNaN(d.getTime())) throw new RunRefusal('invalid start time');
  const name = `${branchPrefix}-${stamp(d)}`;
  if (!SAFE_BRANCH.test(name) || name.startsWith('-') || name.includes('..') || tryGit(root, ['check-ref-format', '--branch', name]) === null) {
    throw new RunRefusal('the run branch name is not valid');
  }
  if (tryGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]) !== null) {
    throw new RunRefusal(`the branch "${plainText(name, 80)}" already exists: wait a second or delete it`);
  }
  excludeRunLogs(info);
  try {
    runGit(root, ['switch', '-c', name]);
  } catch {
    throw new RunRefusal('cannot create the run branch');
  }
  return { branch: name, baseBranch: current, baseCommit: head, resumed: false };
});

// ---------- commit ----------
const sanitizeId = (id) => {
  let out = '';
  for (const ch of String(id).toLowerCase()) if ('abcdefghijklmnopqrstuvwxyz0123456789:_.-'.includes(ch)) out += ch;
  return out || 'step';
};

/** `feat(migration): <id>: <title>`, one line, at most 72 characters, redacted, no trailers. */
function commitSubject(step, title) {
  const t = plainText(title ?? step.title ?? '', 200);
  const subject = `feat(migration): ${sanitizeId(step.id)}${t ? `: ${t}` : ''}`;
  return subject.slice(0, 72).trimEnd();
}

/** [{ mode, sha, status, path }] of the staged changes (repo-relative paths). */
function stagedRecords(root) {
  const out = runGit(root, ['diff', '--cached', '--raw', '--full-index', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color']);
  const tokens = out.split('\0');
  const records = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const head = tokens[i];
    if (!head.startsWith(':')) break;
    const f = head.slice(1).split(' ');
    records.push({ mode: f[1], sha: f[3], status: f[4], path: tokens[i + 1] });
  }
  return records;
}

/**
 * Resolves a symlink target one component at a time from the real directory `base` (every `cur` below is a real path
 * without symlinks, so ".." is exact even after a link such as dd -> outside). Returns the absolute result, or null
 * when the chain is too long.
 */
function resolveTarget(base, target) {
  let cur = target.startsWith('/') ? path.parse(base).root : base;
  const queue = target.split('/');
  let hops = 0;
  while (queue.length > 0) {
    const seg = queue.shift();
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(next);
    } catch {
      return path.resolve(next, ...queue); // does not exist: nothing below it can be a link
    }
    if (st.isSymbolicLink()) {
      if (++hops > 40) return null;
      const t = fs.readlinkSync(next);
      if (t.startsWith('/')) cur = path.parse(cur).root;
      queue.unshift(...t.split('/'));
    } else cur = next;
  }
  return cur;
}

function symlinkEscapes(root, top, rec, gitDirs) {
  const target = runGit(root, ['cat-file', 'blob', rec.sha]);
  if (target.includes('\0')) return true;
  let base;
  try {
    base = fs.realpathSync(path.join(top, path.dirname(rec.path)));
  } catch {
    return true;
  }
  const real = resolveTarget(base, target);
  if (real === null || !(real === top || real.startsWith(top + path.sep))) return true;
  // A link into the git folder would expose or let others rewrite config and hooks.
  return [path.join(top, '.git'), ...gitDirs].some((g) => real === g || real.startsWith(g + path.sep));
}

/** Returns a plain refusal message for the first unsafe staged record, or null. */
function unsafeStaged(root, top, prefix, records, gitDirs) {
  const blobs = [];
  for (const r of records) {
    const shown = plainText(r.path, 120);
    const segs = r.path.split('/');
    if (!r.path.startsWith(prefix) || segs.includes('..') || r.path.startsWith('/')) return `a staged path is outside the project: ${shown}`;
    if (segs.some((s) => s.toLowerCase() === '.git')) return `a staged path is inside a .git folder: ${shown}`;
    if (isRuns(r.path, prefix)) return `runner logs must not be committed: ${shown}`;
    if (r.status === 'D') continue;
    if (r.mode === '160000') return `a staged path is a submodule: ${shown}`;
    if (r.mode === '120000') {
      if (symlinkEscapes(root, top, r, gitDirs)) return `a staged symlink points outside the repository: ${shown}`;
    } else blobs.push(r);
  }
  if (blobs.length > 0) {
    const out = runGit(root, ['cat-file', '--batch-check=%(objectsize)'], { input: `${blobs.map((b) => b.sha).join('\n')}\n` });
    const sizes = out.split('\n');
    for (let i = 0; i < blobs.length; i++) {
      if (!(Number(sizes[i]) <= MAX_FILE_BYTES)) return `a staged file is larger than 5 MB: ${plainText(blobs[i].path, 120)}`;
    }
  }
  return null;
}

function unstage(root) {
  try {
    runGit(root, ['reset', '-q']);
  } catch {
    // nothing more to do: the caller already refuses
  }
}

/**
 * Stages everything except .ai/runs/ (so the roadmap edit lands in the same commit), checks the staged set, and makes
 * ONE commit `feat(migration): <step id>: <title>` (title: `title` argument, else step.title). Returns
 * { commit, filesChanged } (project-relative paths, raw: sanitize before printing) or null when nothing is staged.
 * Refuses (RunRefusal, index reset, no commit) for a staged path outside the project, inside .git/, a submodule,
 * a symlink pointing outside the repository or a file over 5 MB, and when no git identity is configured.
 * No trailers, --no-verify, hooks disabled, -c user.useConfigOnly=true: the runner never invents an identity.
 */
export const commitStep = plainErrors((root, step, title) => {
  const info = repoInfo(root);
  const { top, prefix } = info;
  root = info.root;
  refuseTrackedRuns(root);
  let records;
  try {
    // Once .ai/runs/ is in .git/info/exclude git refuses a pathspec that names it ("paths are ignored"), and then it is
    // never staged anyway; otherwise the exclude pathspec keeps it out. Either way a staged runs path is refused below.
    const ignored = tryGit(root, ['check-ignore', '-q', '--', `${RUNS_DIR}/.confirmed`]) !== null;
    runGit(root, ['add', '-A', '--', '.', ...(ignored ? [] : [`:(exclude,icase)${RUNS_DIR}`])]);
    records = stagedRecords(root);
    if (records.length === 0) return null;
    const problem = unsafeStaged(root, top, prefix, records, [info.common, info.gitDir]);
    if (problem) throw new RunRefusal(problem);
    if (tryGit(root, ['-c', 'user.useConfigOnly=true', 'var', 'GIT_COMMITTER_IDENT']) === null || tryGit(root, ['-c', 'user.useConfigOnly=true', 'var', 'GIT_AUTHOR_IDENT']) === null) {
      throw new RunRefusal('no git identity is configured: set user.name and user.email (git config user.name ...); the runner never invents one');
    }
    runGit(root, ['-c', 'user.useConfigOnly=true', 'commit', '--no-verify', '--no-gpg-sign', '-m', commitSubject(step, title)]);
  } catch (err) {
    unstage(root);
    if (err instanceof GitFailure) throw new RunRefusal(err.status === null ? 'git failed while committing' : 'git commit failed');
    throw err;
  }
  const commit = runGit(root, ['rev-parse', 'HEAD']).trim();
  const filesChanged = records.map((r) => r.path.slice(prefix.length)).sort();
  return { commit, filesChanged };
});

// ---------- diff ----------
/**
 * Changes committed between `commit` and HEAD within the project (.ai/runs excluded):
 * { files (project-relative, raw), insertions, deletions } (binary files count as files, no lines).
 */
export const diffSince = plainErrors((root, commit) => {
  if (typeof commit !== 'string' || !/^[0-9a-f]{4,64}$/.test(commit)) throw new RunRefusal('not a commit id');
  root = repoInfo(root).root;
  if (tryGit(root, ['rev-parse', '--verify', '-q', `${commit}^{commit}`]) === null) throw new RunRefusal('unknown or ambiguous commit');
  const out = runGit(root, ['diff', '--numstat', '-z', '--relative', '--no-renames', '--no-ext-diff', '--no-textconv', commit, 'HEAD', '--', '.', `:(exclude,icase)${RUNS_DIR}`]);
  const files = [];
  let insertions = 0;
  let deletions = 0;
  for (const t of out.split('\0')) {
    if (!t) continue;
    const a = t.indexOf('\t');
    const b = t.indexOf('\t', a + 1);
    if (a < 0 || b < 0) continue;
    insertions += Number(t.slice(0, a)) || 0;
    deletions += Number(t.slice(a + 1, b)) || 0;
    files.push(t.slice(b + 1));
  }
  return { files, insertions, deletions };
});

/** True when the tree has uncommitted or untracked changes outside .ai/runs/ and outside `ignore` (project-relative paths). */
export const hasChanges = plainErrors((root, { ignore = [] } = {}) => {
  const info = repoInfo(root);
  return dirtyEntries(info.root, info.prefix, ignore).length > 0;
});

// ---------- first-use confirmation ----------
// The consent lives in the git dir (<git common dir>/android-architect/confirmed.json), never in the working tree: a
// repository cannot ship it. It is bound to the exact config bytes and agent argv.
function readConfigBytes(root) {
  let cur = root;
  for (const part of ['.ai', 'run.config.json']) {
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if (err.code === 'ENOENT') return Buffer.alloc(0);
      throw new RunRefusal(`${RUN_CONFIG_FILE} cannot be read`);
    }
    if (st.isSymbolicLink()) throw new RunRefusal(`${RUN_CONFIG_FILE} must not be reached through a symlink`);
    if (part === 'run.config.json' && (!st.isFile() || st.size > MAX_CONFIG_BYTES)) throw new RunRefusal(`${RUN_CONFIG_FILE} must be a regular file of at most ${MAX_CONFIG_BYTES} bytes`);
  }
  return fs.readFileSync(cur);
}

/** sha256 over the exact config bytes, a newline and the effective agent argv as JSON. */
export function consentHash(configBytes, agentArgv) {
  return crypto.createHash('sha256').update(Buffer.concat([configBytes, Buffer.from(`\n${JSON.stringify(agentArgv)}`)])).digest('hex');
}

function consentFile(common) {
  return { dir: path.join(common, CONSENT_DIR), file: path.join(common, CONSENT_DIR, CONSENT_NAME) };
}

function storedConsentHash(common) {
  const { dir, file } = consentFile(common);
  try {
    const d = fs.lstatSync(dir);
    if (!d.isDirectory()) return null;
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_CONSENT_BYTES) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && v.schemaVersion === 1 && typeof v.hash === 'string' ? v.hash : null;
  } catch {
    return null;
  }
}

function writeConsent(common, text) {
  const { dir, file } = consentFile(common);
  try {
    let d = null;
    try {
      d = fs.lstatSync(dir);
    } catch {
      fs.mkdirSync(dir, { mode: 0o700 });
      d = fs.lstatSync(dir);
    }
    if (!d.isDirectory()) throw new Error('not a directory');
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error('not a file');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  } catch {
    throw new RunRefusal('cannot record the confirmation in the git folder');
  }
}

const joinArgv = (argv) => argv.map((a) => plainText(a, 120)).join(' ');

/**
 * First-use consent per clone. Valid only while <git dir>/android-architect/confirmed.json holds the hash of the
 * CURRENT run.config.json bytes plus the effective agent argv (any change re-prompts); a file inside the working tree
 * is ignored. Prints the statement through `say` and asks `confirm()` (a function; may be async). On yes it adds
 * `.ai/runs/` (the logs) to .git/info/exclude and writes the consent (no symlinks, regular file, mode 0600).
 * The displayed config comes from the same bytes that are hashed; a `config` that differs from them refuses.
 * Returns a Promise<boolean>.
 */
export async function confirmFirstUse(root, { confirm, say, config, agentArgv }) {
  if (typeof confirm !== 'function' || typeof say !== 'function') throw new RunRefusal('confirmFirstUse needs confirm and say functions');
  if (!Array.isArray(agentArgv) || agentArgv.some((a) => typeof a !== 'string')) throw new RunRefusal('the agent command is not a list of strings');
  return plainErrors(async () => {
    const info = repoInfo(root);
    refuseTrackedRuns(info.root);
    const bytes = readConfigBytes(info.root);
    let shown;
    if (bytes.length === 0) shown = DEFAULT_RUN_CONFIG;
    else {
      let value;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new RunRefusal(`${RUN_CONFIG_FILE} is not valid JSON`);
      }
      shown = validateRunConfig(value, info.root).config;
      if (shown === null) throw new RunRefusal(`${RUN_CONFIG_FILE} is not valid`);
    }
    if (config !== undefined && config !== null && JSON.stringify(config) !== JSON.stringify(shown)) {
      throw new RunRefusal(`${RUN_CONFIG_FILE} changed while the run was starting; start again`);
    }
    const hash = consentHash(bytes, agentArgv);
    if (storedConsentHash(info.common) === hash) return true;
    const commands = shown.verification.commands.map(joinArgv);
    say('Before the first run (and again whenever .ai/run.config.json or the agent command changes):');
    say("Note: verification runs your project's Gradle build code and may reach the network.");
    say("The run config (.ai/run.config.json) and the project's Gradle code run as you, with your user permissions, and so does the agent.");
    say('They inherit your HOME and PATH, so the build code can read files such as ~/.gradle, ~/.ssh and ~/.npmrc.');
    say(`Agent command: ${joinArgv(agentArgv)}`);
    say(`Verification commands: ${commands.length > 0 ? commands.join(' ; ') : '(none)'}`);
    say('Confirm only if you trust this repository and its run.config.json.');
    if ((await confirm()) !== true) return false;
    excludeRunLogs(info);
    writeConsent(info.common, `${JSON.stringify({ schemaVersion: 1, hash, confirmedAt: new Date().toISOString() })}\n`);
    return true;
  })();
}
