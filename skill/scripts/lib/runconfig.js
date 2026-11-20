// .ai/run.config.json: settings of the autonomous run loop. The file lives in the repo, so it is untrusted input:
// everything is validated before use (strict keys, caps, argv arrays only, a denylist of network and publishing
// commands), nothing is evaluated and nothing is passed to a shell. Errors are prefixed with the file name.
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
const isAbsolute = (s) => s.startsWith('/') || s.startsWith('\\') || s.startsWith('~') || /^[A-Za-z]:/.test(s);

function checkKeys(obj, allowed, where, bad) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(`${where}: unknown key ${JSON.stringify(k.slice(0, 40))}`);
}

/** Problems of one argv (empty when fine). `exeRule`: 'bare' (no separators) or 'project' (bare name or relative path inside the project). */
function argvProblems(argv, where, root, exeRule) {
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
  if (hasSep(exe)) {
    if (exeRule === 'bare') out.push(`${where}[0]: must be a bare command name without a path (use kind "custom" for a project script)`);
    else if (isAbsolute(exe) || hasDotDot(exe) || !(path.resolve(root, exe) + path.sep).startsWith(path.resolve(root) + path.sep)) {
      out.push(`${where}[0]: a path must be relative to the project root and stay inside it`);
    }
  }
  for (let i = 1; i < argv.length; i++) {
    if (isAbsolute(argv[i]) || hasDotDot(argv[i])) out.push(`${where}[${i}]: absolute paths and ".." are not allowed as arguments`);
  }
  const exeName = baseName(exe);
  for (let i = 0; i < argv.length; i++) {
    if (DENIED_EXES.includes(baseName(argv[i]))) out.push(`${where}[${i}]: network commands are not allowed`);
    else if (i > 0 && VCS_EXES.includes(exeName) && DENIED_SUBCOMMANDS.includes(argv[i].toLowerCase())) {
      out.push(`${where}[${i}]: "${argv[i].toLowerCase()}" is not allowed after ${exeName}`);
    }
  }
  return out;
}

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
          const p = argvProblems(a.command, 'agent.command', root, a.kind === 'custom' ? 'project' : 'bare');
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
            if (!validEnvName(k)) bad(`agent.env key ${JSON.stringify(k.slice(0, 40))} must be A-Z, 0-9 and "_" only`);
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
            const p = argvProblems(c, `verification.commands[${i}]`, root, 'project');
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
    st = fs.lstatSync(file);
  } catch (err) {
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
