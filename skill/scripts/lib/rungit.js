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
import { writeGenerated } from './aidir.js';
import { RUN_CONFIG_FILE } from './runconfig.js';

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
const CONSENT_FILE = '.ai/runs/.confirmed';
const MAX_CONSENT_BYTES = 4096;
const MAX_CONFIG_BYTES = 64 * 1024;

// ---------- the network guard ----------
const FORBIDDEN_GIT = new Set(['push', 'fetch', 'pull', 'clone', 'remote', 'merge', 'rebase', 'submodule', 'ls-remote', 'request-pull', 'send-email', 'daemon', 'instaweb']);
const FORBIDDEN_OPTION_PREFIXES = ['--upload-pack', '--receive-pack', '--exec'];
const FORBIDDEN_EXES = new Set(['curl', 'wget', 'ssh', 'scp', 'nc', 'ncat', 'telnet', 'ftp']);

/**
 * Throws RunRefusal when `argv` (with or without a leading `git`) could touch the network or publish: any element
 * that is exactly a network/history-merging git subcommand (compared case-insensitively, wherever it appears, so
 * global options in front cannot hide it), an option starting with --upload-pack, --receive-pack or --exec, or an
 * executable such as curl, wget, ssh, scp, nc or `npm publish`.
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
];

/** The git subcommand of an args list (skips global options and the value of -c / -C). */
function subcommandOf(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return 'git';
}

class GitFailure extends Error {
  constructor(sub, status) {
    super(`git ${sub} failed`);
    this.name = 'GitFailure';
    this.status = status;
  }
}

/**
 * Runs `git <args>` in `root` and returns stdout (utf8, untrimmed). Every call goes through assertNeverNetwork first.
 * Throws GitFailure (message "git <subcommand> failed", `status` = exit code or null) on a non-zero exit.
 */
export function runGit(root, args, { input } = {}) {
  assertNeverNetwork(['git', ...args]);
  const env = cleanGitEnv({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
  try {
    return execFileSync('git', [...HARDENING, ...args], {
      cwd: root,
      env,
      input,
      encoding: 'utf8',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err.code === 'ENOENT') throw new RunRefusal('git is not available');
    throw new GitFailure(subcommandOf(args), typeof err.status === 'number' ? err.status : null);
  }
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
function repoInfo(root) {
  const top = tryGit(root, ['rev-parse', '--show-toplevel']);
  if (!top) throw new RunRefusal('not a git repository: the runner needs a git repository with at least one commit');
  const prefix = runGit(root, ['rev-parse', '--show-prefix']).replace(/\n$/, '');
  return { top: fs.realpathSync(top), prefix };
}

const isRuns = (p, prefix) => p === `${prefix}${RUNS_DIR}` || p.startsWith(`${prefix}${RUNS_DIR}/`);

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

function refuseTrackedRuns(root) {
  const tracked = runGit(root, ['ls-files', '-z', '--', RUNS_DIR]);
  if (tracked !== '') throw new RunRefusal('.ai/runs/ contains files tracked by git; the runner logs and consent are local only: remove them from git first (git rm --cached)');
}

/** Adds the anchored `/<project prefix>.ai/runs/` line to .git/info/exclude. */
function excludeRunLogs(root, prefix) {
  const escaped = `${prefix}${RUNS_DIR}/`.replace(/[\\*?[\]]/g, '\\$&');
  try {
    const common = path.resolve(root, runGit(root, ['rev-parse', '--git-common-dir']).replace(/\n$/, ''));
    addToExclude(root, [`/${escaped}`], { commonDir: common });
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
 * Refuses (RunRefusal, nothing changed) when: not a repository, no commits, detached HEAD, the current branch is a
 * default branch (target of refs/remotes/origin/HEAD, else main/master/trunk/develop; a custom default name without
 * origin/HEAD is detectable only through `protectedBranches` from run.config.json), the tree is not clean
 * (untracked files count; .ai/runs/ does not), .ai/runs/ holds tracked files, or .git/info/exclude cannot be updated.
 * On a branch named `<branchPrefix>-...` the run resumes: nothing new is created and baseBranch is null.
 * `resumeDirtyOk` lists project-relative paths (the roadmap) that may be dirty on resume: a stopped run leaves its
 * `doing` row uncommitted on purpose.
 */
export function startRunBranch(root, { branchPrefix, now, protectedBranches = [], resumeDirtyOk = [] } = {}) {
  const { prefix } = repoInfo(root);
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
    excludeRunLogs(root, prefix);
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
  excludeRunLogs(root, prefix);
  try {
    runGit(root, ['switch', '-c', name]);
  } catch {
    throw new RunRefusal('cannot create the run branch');
  }
  return { branch: name, baseBranch: current, baseCommit: head, resumed: false };
}

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
  const out = runGit(root, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color']);
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

function symlinkEscapes(root, top, rec) {
  const target = runGit(root, ['cat-file', 'blob', rec.sha]);
  if (target.includes('\0')) return true;
  let base;
  try {
    base = fs.realpathSync(path.join(top, path.dirname(rec.path)));
  } catch {
    return true;
  }
  const cand = path.resolve(base, target);
  let real = cand;
  try {
    real = fs.realpathSync(cand);
  } catch {
    // a dangling link is judged by where it points lexically
  }
  return !(real === top || real.startsWith(top + path.sep));
}

/** Returns a plain refusal message for the first unsafe staged record, or null. */
function unsafeStaged(root, top, prefix, records) {
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
      if (symlinkEscapes(root, top, r)) return `a staged symlink points outside the repository: ${shown}`;
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
export function commitStep(root, step, title) {
  const { top, prefix } = repoInfo(root);
  refuseTrackedRuns(root);
  try {
    // Once .ai/runs/ is in .git/info/exclude git refuses a pathspec that names it ("paths are ignored"), and then it is
    // never staged anyway; otherwise the exclude pathspec keeps it out. Either way a staged runs path is refused below.
    const ignored = tryGit(root, ['check-ignore', '-q', '--', `${RUNS_DIR}/.confirmed`]) !== null;
    runGit(root, ['add', '-A', '--', '.', ...(ignored ? [] : [`:(exclude)${RUNS_DIR}`])]);
  } catch {
    unstage(root);
    throw new RunRefusal('cannot stage the changes');
  }
  const records = stagedRecords(root);
  if (records.length === 0) return null;
  const problem = unsafeStaged(root, top, prefix, records);
  if (problem) {
    unstage(root);
    throw new RunRefusal(problem);
  }
  if (tryGit(root, ['-c', 'user.useConfigOnly=true', 'var', 'GIT_COMMITTER_IDENT']) === null || tryGit(root, ['-c', 'user.useConfigOnly=true', 'var', 'GIT_AUTHOR_IDENT']) === null) {
    unstage(root);
    throw new RunRefusal('no git identity is configured: set user.name and user.email (git config user.name ...); the runner never invents one');
  }
  try {
    runGit(root, ['-c', 'user.useConfigOnly=true', 'commit', '--no-verify', '--no-gpg-sign', '-m', commitSubject(step, title)]);
  } catch {
    unstage(root);
    throw new RunRefusal('git commit failed');
  }
  const commit = runGit(root, ['rev-parse', 'HEAD']).trim();
  const filesChanged = records.map((r) => r.path.slice(prefix.length)).sort();
  return { commit, filesChanged };
}

// ---------- diff ----------
/**
 * Changes committed between `commit` and HEAD within the project (.ai/runs excluded):
 * { files (project-relative, raw), insertions, deletions } (binary files count as files, no lines).
 */
export function diffSince(root, commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{4,64}$/.test(commit)) throw new RunRefusal('not a commit id');
  if (tryGit(root, ['rev-parse', '--verify', '-q', `${commit}^{commit}`]) === null) throw new RunRefusal('unknown commit');
  const out = runGit(root, ['diff', '--numstat', '-z', '--relative', '--no-renames', '--no-ext-diff', '--no-textconv', commit, 'HEAD', '--', '.', `:(exclude)${RUNS_DIR}`]);
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
}

/** True when the tree has uncommitted or untracked changes outside .ai/runs/ and outside `ignore` (project-relative paths). */
export function hasChanges(root, { ignore = [] } = {}) {
  const { prefix } = repoInfo(root);
  return dirtyEntries(root, prefix, ignore).length > 0;
}

// ---------- first-use confirmation ----------
function readConfigBytes(root) {
  const file = path.join(root, RUN_CONFIG_FILE);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return Buffer.alloc(0);
    throw new RunRefusal(`${RUN_CONFIG_FILE} cannot be read`);
  }
  if (!st.isFile() || st.size > MAX_CONFIG_BYTES) throw new RunRefusal(`${RUN_CONFIG_FILE} must be a regular file of at most ${MAX_CONFIG_BYTES} bytes`);
  return fs.readFileSync(file);
}

/** sha256 over the exact config bytes, a newline and the effective agent argv as JSON. */
export function consentHash(configBytes, agentArgv) {
  return crypto.createHash('sha256').update(Buffer.concat([configBytes, Buffer.from(`\n${JSON.stringify(agentArgv)}`)])).digest('hex');
}

function storedConsentHash(root) {
  const dir = path.join(root, RUNS_DIR);
  try {
    if (fs.lstatSync(path.join(root, '.ai')).isSymbolicLink() || fs.lstatSync(dir).isSymbolicLink()) return null;
    const file = path.join(root, CONSENT_FILE);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_CONSENT_BYTES) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && v.schemaVersion === 1 && typeof v.hash === 'string' ? v.hash : null;
  } catch {
    return null;
  }
}

const joinArgv = (argv) => argv.map((a) => plainText(a, 120)).join(' ');

/**
 * First-use consent per project. Valid only while `.ai/runs/.confirmed` holds the hash of the CURRENT run.config.json
 * bytes plus the effective agent argv (any change re-prompts). A consent file tracked by git is refused: a repository
 * could ship a forged one. Otherwise prints the statement through `say` and asks `confirm()` (may be async); on yes it
 * adds `.ai/runs/` to .git/info/exclude and writes the consent through the guarded .ai writer. Returns a Promise<boolean>.
 */
export async function confirmFirstUse(root, { confirm, say, config, agentArgv }) {
  const { prefix } = repoInfo(root);
  refuseTrackedRuns(root);
  const hash = consentHash(readConfigBytes(root), agentArgv);
  if (storedConsentHash(root) === hash) return true;
  const commands = (config?.verification?.commands ?? []).map(joinArgv);
  say('Before the first run (and again whenever .ai/run.config.json or the agent command changes):');
  say("Note: verification runs your project's Gradle build code and may reach the network.");
  say("The run config (.ai/run.config.json) and the project's Gradle code run as you, with your user permissions, and so does the agent.");
  say(`Agent command: ${joinArgv(agentArgv)}`);
  say(`Verification commands: ${commands.length > 0 ? commands.join(' ; ') : '(none)'}`);
  say('Confirm only if you trust this repository and its run.config.json.');
  if ((await confirm()) !== true) return false;
  excludeRunLogs(root, prefix);
  try {
    writeGenerated(root, { 'runs/.confirmed': `${JSON.stringify({ schemaVersion: 1, hash, confirmedAt: new Date().toISOString() })}\n` });
  } catch (err) {
    throw new RunRefusal(plainText(err.message, 200));
  }
  return true;
}
