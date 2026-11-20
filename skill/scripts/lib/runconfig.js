// .ai/run.config.json: settings of the autonomous run loop. The file is committed, so it is PR-controlled input and a
// guard rail, not a sandbox: everything is validated before use (strict keys, caps, argv arrays only, an executable
// ALLOWLIST for verification commands and per agent kind, a denylist of network and publishing words as defense in
// depth, denied environment names), nothing is evaluated and nothing is passed to a shell. kind "custom" is user-trusted
// (any bare name or project-relative script). Errors are prefixed with the file name.
import fs from 'node:fs';
import path from 'node:path';

export const RUN_CONFIG_FILE = '.ai/run.config.json';
const PREFIX = `${RUN_CONFIG_FILE}: `;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_ARG = 500;
const MAX_ARGV = 50;
const MAX_COMMANDS = 20;
const MAX_ENV = 50;
const MAX_BRANCH_PREFIX = 100;
const HARD_MAX = Object.freeze({ maxIterations: 200, maxTotalTokens: 20_000_000, maxTurnsPerStep: 200, maxWallClockMinutes: 24 * 60 });
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const KINDS = ['claude', 'codex', 'custom'];
const VCS_EXES = ['git', 'npm', 'yarn', 'pnpm'];
const DENIED_SUBCOMMANDS = ['push', 'publish', 'remote', 'merge', 'fetch', 'pull', 'clone', 'rebase'];
const DENIED_EXES = ['curl', 'wget', 'ssh', 'scp', 'nc', 'ncat', 'telnet', 'ftp'];

export const DEFAULT_RUN_CONFIG = Object.freeze({
  schemaVersion: 1,
  agent: Object.freeze({ kind: 'claude', command: Object.freeze(['claude']) }),
  budgets: Object.freeze({ maxIterations: 10, maxTotalTokens: 400000, maxTurnsPerStep: 20, maxWallClockMinutes: 120 }),
  verification: Object.freeze({ commands: Object.freeze([Object.freeze(['./gradlew', 'assembleDebug', 'testDebugUnitTest', 'lint'])]), timeoutSeconds: 1800 }),
  branchPrefix: 'android-architect/run',
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasControl = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
};
const baseName = (s) => {
  const parts = s.split(/[\\/]/);
  let b = (parts[parts.length - 1] ?? '').toLowerCase();
  if (b.endsWith('.exe') || b.endsWith('.cmd') || b.endsWith('.bat')) b = b.slice(0, -4);
  return b;
};
const hasSep = (s) => s.includes('/') || s.includes('\\');
const hasDotDot = (s) => s.split(/[\\/]/).some((seg) => seg === '..');
const isAbsolute = (s) => s.startsWith('/') || s.startsWith('\\') || s.startsWith('~') || /^[A-Za-z]:[\\/]/.test(s);

function checkKeys(obj, allowed, where, bad) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(`${where}: unknown key ${JSON.stringify(k.slice(0, 40))}`);
}

const GRADLE_EXES = ['./gradlew', 'gradlew', 'gradle'];

/** True for a script path that is relative, has no ".." and stays inside the project. */
function insideProject(p, root) {
  return !isAbsolute(p) && !hasDotDot(p) && (path.resolve(root, p) + path.sep).startsWith(path.resolve(root) + path.sep);
}

/** Allowlist for one verification command (empty when fine). */
function verificationAllowProblems(argv, where, root) {
  const exe = argv[0];
  if (GRADLE_EXES.includes(exe)) {
    const out = [];
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i].toLowerCase();
      const task = a.slice(a.lastIndexOf(':') + 1);
      if (task.startsWith('publish')) out.push(`${where}[${i}]: publishing tasks are not allowed`);
      else if (argv[i] === '-I' || a === '--init-script' || a.startsWith('--init-script=')) out.push(`${where}[${i}]: init scripts are not allowed`);
    }
    return out;
  }
  if (exe === 'node') {
    if (argv.length < 2 || argv[1].startsWith('-') || !insideProject(argv[1], root)) {
      return [`${where}[1]: node must run a script path relative to the project root (no flags such as -e, --eval, -p, --print, -r)`];
    }
    return [];
  }
  if (exe === 'npm') {
    const ok = (argv.length === 2 && argv[1] === 'test') || (argv.length === 3 && argv[1] === 'run' && argv[2] === 'test');
    return ok ? [] : [`${where}: npm is only allowed as "npm test" or "npm run test"`];
  }
  return [`${where}[0]: is not an allowed verification command (allowed: ./gradlew, gradlew, gradle, node <script>, npm test)`];
}

/** Problems of one argv (empty when fine). `kind`: 'verification' or the agent kind (claude, codex, custom). */
function argvProblems(argv, where, root, kind) {
  if (!Array.isArray(argv)) return [`${where}: must be an array of strings`];
  if (argv.length === 0) return [`${where}: must not be empty`];
  if (argv.length > MAX_ARGV) return [`${where}: has more than ${MAX_ARGV} elements`];
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const at = `${where}[${i}]`;
    if (typeof a !== 'string' || a.length === 0) out.push(`${at}: must be a non-empty string`);
    else if (a.length > MAX_ARG) out.push(`${at}: is longer than ${MAX_ARG} characters`);
    else if (hasControl(a)) out.push(`${at}: must not contain control characters or newlines`);
  }
  if (out.length > 0) return out;
  const exe = argv[0];
  if (kind === 'claude' || kind === 'codex') {
    if (exe !== kind) out.push(`${where}[0]: must be exactly "${kind}" for kind "${kind}" (use kind "custom" for another program)`);
  } else if (kind === 'custom') {
    if (hasSep(exe) && !insideProject(exe, root)) out.push(`${where}[0]: a path must be relative to the project root and stay inside it`);
  } else {
    out.push(...verificationAllowProblems(argv, where, root));
  }
  for (let i = 1; i < argv.length; i++) {
    if (isAbsolute(argv[i]) || hasDotDot(argv[i])) out.push(`${where}[${i}]: absolute paths and ".." are not allowed as arguments`);
  }
  // Defense in depth: executables and subcommands that publish or touch the network.
  const exeName = baseName(exe);
  if (DENIED_EXES.includes(exeName)) out.push(`${where}[0]: network commands are not allowed`);
  if (VCS_EXES.includes(exeName)) {
    for (let i = 1; i < argv.length; i++) {
      if (DENIED_SUBCOMMANDS.includes(argv[i].toLowerCase())) out.push(`${where}[${i}]: "${argv[i].toLowerCase()}" is not allowed after ${exeName}`);
    }
  }
  return out;
}

const deniedEnvName = (k) => {
  const u = k.toUpperCase();
  return u === 'PATH' || u === 'HOME' || u === 'NODE_OPTIONS' || u.startsWith('LD_') || u.startsWith('DYLD_') || u.startsWith('GIT_') || u.startsWith('SSH_') || u.endsWith('_PROXY');
};
const validEnvName = (k) => {
  if (k.length === 0 || k.length > 64) return false;
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95)) return false;
  }
  return true;
};

function branchPrefixProblem(v) {
  if (typeof v !== 'string' || v.length === 0) return 'must be a non-empty string';
  if (v.length > MAX_BRANCH_PREFIX) return `is longer than ${MAX_BRANCH_PREFIX} characters`;
  for (const ch of v) if (!/[A-Za-z0-9._/-]/.test(ch)) return 'may only contain letters, digits, ".", "_", "-" and "/"';
  if (v.startsWith('/') || v.endsWith('/') || v.includes('//') || v.startsWith('-') || v.includes('..')) return 'is not a safe branch name';
  if (v.split('/').some((seg) => seg.startsWith('.') || seg.endsWith('.lock') || seg.endsWith('.'))) return 'is not a safe branch name';
  return null;
}

/** Validates a parsed config; returns { config, problems } (config is null when there are problems). Missing sections take the defaults. */
export function validateRunConfig(value, root) {
  const problems = [];
  const bad = (m) => problems.push(m);
  if (!isObj(value)) return { config: null, problems: ['must be a JSON object'] };
  checkKeys(value, ['schemaVersion', 'agent', 'budgets', 'verification', 'branchPrefix'], 'config', bad);
  if (value.schemaVersion !== 1) bad('schemaVersion must be 1');
  const d = DEFAULT_RUN_CONFIG;
  const config = {
    schemaVersion: 1,
    agent: { kind: d.agent.kind, command: [...d.agent.command] },
    budgets: { ...d.budgets },
    verification: { commands: d.verification.commands.map((c) => [...c]), timeoutSeconds: d.verification.timeoutSeconds },
    branchPrefix: d.branchPrefix,
  };

  if (Object.hasOwn(value, 'agent')) {
    const a = value.agent;
    if (!isObj(a)) bad('agent must be an object');
    else {
      checkKeys(a, ['kind', 'command', 'env'], 'agent', bad);
      if (!KINDS.includes(a.kind)) bad(`agent.kind must be one of ${KINDS.join(', ')}`);
      else {
        config.agent.kind = a.kind;
        if (!Object.hasOwn(a, 'command')) {
          if (a.kind === 'custom') bad('agent.command is required for kind "custom"');
          else config.agent.command = [a.kind];
        } else {
          const p = argvProblems(a.command, 'agent.command', root, a.kind);
          problems.push(...p);
          if (p.length === 0) config.agent.command = [...a.command];
        }
      }
      if (Object.hasOwn(a, 'env')) {
        if (!isObj(a.env)) bad('agent.env must be an object of strings');
        else {
          const keys = Object.keys(a.env);
          if (keys.length > MAX_ENV) bad(`agent.env has more than ${MAX_ENV} entries`);
          const env = {};
          for (const k of keys.slice(0, MAX_ENV)) {
            const v = a.env[k];
            if (validEnvName(k) && deniedEnvName(k)) bad(`agent.env.${k} is not allowed (PATH, HOME, LD_*, DYLD_*, NODE_OPTIONS, GIT_*, SSH_* and *_PROXY are reserved)`);
            else if (!validEnvName(k)) bad(`agent.env key ${JSON.stringify(k.slice(0, 40))} must be A-Z, 0-9 and "_" only`);
            else if (typeof v !== 'string' || v.length > MAX_ARG || hasControl(v)) bad(`agent.env.${k} must be a printable string of at most ${MAX_ARG} characters`);
            else env[k] = v;
          }
          config.agent.env = env;
        }
      }
    }
  }

  if (Object.hasOwn(value, 'budgets')) {
    const b = value.budgets;
    if (!isObj(b)) bad('budgets must be an object');
    else {
      checkKeys(b, Object.keys(HARD_MAX), 'budgets', bad);
      for (const k of Object.keys(HARD_MAX)) {
        if (!Object.hasOwn(b, k)) continue;
        if (!Number.isSafeInteger(b[k]) || b[k] < 1) bad(`budgets.${k} must be a positive integer`);
        else if (b[k] > HARD_MAX[k]) bad(`budgets.${k} is above the maximum of ${HARD_MAX[k]}`);
        else config.budgets[k] = b[k];
      }
    }
  }

  if (Object.hasOwn(value, 'verification')) {
    const v = value.verification;
    if (!isObj(v)) bad('verification must be an object');
    else {
      checkKeys(v, ['commands', 'timeoutSeconds'], 'verification', bad);
      if (Object.hasOwn(v, 'commands')) {
        if (!Array.isArray(v.commands)) bad('verification.commands must be an array of argv arrays');
        else if (v.commands.length > MAX_COMMANDS) bad(`verification.commands has more than ${MAX_COMMANDS} commands`);
        else {
          const cmds = [];
          v.commands.forEach((c, i) => {
            const p = argvProblems(c, `verification.commands[${i}]`, root, 'verification');
            problems.push(...p);
            if (p.length === 0) cmds.push([...c]);
          });
          config.verification.commands = cmds;
        }
      }
      if (Object.hasOwn(v, 'timeoutSeconds')) {
        if (!Number.isSafeInteger(v.timeoutSeconds) || v.timeoutSeconds < 1) bad('verification.timeoutSeconds must be a positive integer');
        else if (v.timeoutSeconds > MAX_TIMEOUT_SECONDS) bad(`verification.timeoutSeconds is above the maximum of ${MAX_TIMEOUT_SECONDS}`);
        else config.verification.timeoutSeconds = v.timeoutSeconds;
      }
    }
  }

  if (Object.hasOwn(value, 'branchPrefix')) {
    const p = branchPrefixProblem(value.branchPrefix);
    if (p) bad(`branchPrefix ${p}`);
    else config.branchPrefix = value.branchPrefix;
  }
  return problems.length > 0 ? { config: null, problems } : { config, problems };
}

/**
 * Loads <root>/.ai/run.config.json: the defaults when the file is missing; a symlink, a non-regular or oversized file,
 * invalid JSON or any validation problem throws an Error whose message lists every problem prefixed with the file name.
 */
export function loadRunConfig(root) {
  const file = path.join(root, RUN_CONFIG_FILE);
  let st;
  try {
    if (fs.lstatSync(path.join(root, '.ai')).isSymbolicLink()) throw new Error(`${PREFIX}must be a regular file (symlinks are not followed)`);
    st = fs.lstatSync(file);
  } catch (err) {
    if (err.message.startsWith(PREFIX)) throw err;
    if (err.code === 'ENOENT') return validateRunConfig({ schemaVersion: 1 }, root).config;
    throw new Error(`${PREFIX}cannot be read (${err.code ?? 'error'})`);
  }
  if (!st.isFile()) throw new Error(`${PREFIX}must be a regular file (symlinks are not followed)`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`${PREFIX}is larger than ${MAX_FILE_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${PREFIX}is not valid JSON`);
  }
  const { config, problems } = validateRunConfig(value, root);
  if (config === null) throw new Error(problems.map((p) => PREFIX + p).join('\n'));
  return config;
}
