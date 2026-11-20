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
const MAX_LIST = 20;
const MAX_BRANCH_PREFIX = 100;
const MAX_PROTECTED = 20;
const HARD_MAX = Object.freeze({ maxIterations: 200, maxTotalTokens: 20_000_000, maxTurnsPerStep: 200, maxWallClockMinutes: 24 * 60 });
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const KINDS = ['claude', 'codex', 'custom'];
const VCS_EXES = ['git', 'npm', 'yarn', 'pnpm'];
const DENIED_SUBCOMMANDS = ['push', 'publish', 'remote', 'merge', 'fetch', 'pull', 'clone', 'rebase'];
const DENIED_EXES = ['curl', 'wget', 'ssh', 'scp', 'nc', 'ncat', 'telnet', 'ftp'];

export const DEFAULT_RUN_CONFIG = Object.freeze({
  schemaVersion: 1,
  agent: Object.freeze({ kind: 'claude', command: Object.freeze(['claude']), requireArgs: Object.freeze([]), passEnv: Object.freeze([]) }),
  budgets: Object.freeze({ maxIterations: 10, maxTotalTokens: 400000, maxTurnsPerStep: 20, maxWallClockMinutes: 120 }),
  verification: Object.freeze({ commands: Object.freeze([Object.freeze(['./gradlew', 'assembleDebug', 'testDebugUnitTest', 'lint'])]), timeoutSeconds: 1800 }),
  branchPrefix: 'android-architect/run',
  protectedBranches: Object.freeze([]),
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const hasControl = (s) => {
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

// Names an agent process must never receive from a (PR-controlled) config or via passEnv: PATH and HOME are the
// runner's own; loaders and option injectors (LD_*, DYLD_*, NODE_*, JAVA/GRADLE options, shell startup files, language
// path variables) run code or redirect it; GIT_*, SSH_*, proxies, *_BASE_URL, *_API_URL and *_ENDPOINT redirect network
// traffic (and with it any secret passed in); CLAUDE_* and CODEX_* redirect the agent's own configuration.
const DENIED_ENV_EXACT = [
  'PATH', 'HOME', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'JAVA_HOME',
  'GRADLE_OPTS', 'GRADLE_USER_HOME', 'BASH_ENV', 'ENV', 'SHELL', 'SHELLOPTS', 'BASHOPTS', 'PROMPT_COMMAND', 'PS4', 'IFS', 'TMPDIR',
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'USER', 'LOGNAME', 'LANG',
];
const DENIED_ENV_PREFIX = ['LD_', 'DYLD_', 'GIT_', 'SSH_', 'CLAUDE_', 'CODEX_', 'NODE_', 'NPM_', 'GRADLE_', 'JAVA_', 'ANDROID_'];
const DENIED_ENV_SUFFIX = ['_PROXY', '_BASE_URL', '_API_URL', '_ENDPOINT', '_URL', '_HOST'];
/** True for an environment variable name the agent adapter refuses in agent.env and agent.passEnv. */
export const deniedEnvName = (k) => {
  const u = String(k).toUpperCase();
  return DENIED_ENV_EXACT.includes(u) || DENIED_ENV_PREFIX.some((p) => u.startsWith(p)) || DENIED_ENV_SUFFIX.some((x) => u.endsWith(x));
};
export const validEnvName = (k) => {
  if (k.length === 0 || k.length > 64) return false;
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95)) return false;
  }
  return true;
};

// agent.requireArgs: strings that must each appear as an element of the agent argv (a team's restricted-profile flag).
const REQUIRE_ARG_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:=/-';
function requireArgProblem(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_ARG) return `must be a non-empty string of at most ${MAX_ARG} characters`;
  for (const ch of v) if (!REQUIRE_ARG_CHARS.includes(ch)) return 'may only contain letters, digits and ". _ : = / -"';
  return isAbsolute(v) || hasDotDot(v) ? 'must not be an absolute path or contain ".."' : null;
}
// agent.passEnv: NAMES of variables copied from the user's own environment into the agent process (values never live
// here). Only the agent CLIs' own credential/config families may flow (a PR picks names, the user supplies values),
// minus anything that loads or executes code. Note: *_BASE_URL names of these families ARE allowed; a base-URL variable
// in the user's own environment redirects the key they pass (documented in the README).
const PASS_FAMILIES = ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_', 'GEMINI_', 'GOOGLE_GENAI_', 'AZURE_OPENAI_'];
const PASS_DENIED_PREFIX = ['LD_', 'DYLD_', 'NODE_', 'GIT_', 'SSH_'];
const PASS_DENIED_EXACT = ['JAVA_TOOL_OPTIONS', 'BASH_ENV', 'ENV', 'PATH', 'HOME'];
/** True for a variable name that agent.passEnv may carry (shape, family allowlist, loader/exec denylist). */
export function passEnvAllowed(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64 || !/^[A-Z][A-Z0-9_]*$/.test(v)) return false;
  if (PASS_DENIED_EXACT.includes(v) || PASS_DENIED_PREFIX.some((p) => v.startsWith(p))) return false;
  return v === 'GOOGLE_API_KEY' || PASS_FAMILIES.some((p) => v.startsWith(p) && v.length > p.length);
}
function passEnvProblem(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64 || !/^[A-Z][A-Z0-9_]*$/.test(v)) return 'must be a name such as ANTHROPIC_API_KEY (A-Z, 0-9 and "_", starting with a letter)';
  return passEnvAllowed(v) ? null : 'is not allowed (only ANTHROPIC_*, CLAUDE_*, OPENAI_*, CODEX_*, GEMINI_*, GOOGLE_API_KEY, GOOGLE_GENAI_* and AZURE_OPENAI_* names, and never loader or exec variables)';
}
function listOf(value, where, problemOf, bad) {
  if (!Array.isArray(value)) {
    bad(`${where} must be an array of strings`);
    return [];
  }
  if (value.length > MAX_LIST) {
    bad(`${where} has more than ${MAX_LIST} entries`);
    return [];
  }
  const out = [];
  value.forEach((v, i) => {
    const p = problemOf(v);
    if (p) bad(`${where}[${i}] ${p}`);
    else if (!out.includes(v)) out.push(v);
  });
  return out;
}

function branchNameProblem(v) {
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
  checkKeys(value, ['schemaVersion', 'agent', 'budgets', 'verification', 'branchPrefix', 'protectedBranches'], 'config', bad);
  if (value.schemaVersion !== 1) bad('schemaVersion must be 1');
  const d = DEFAULT_RUN_CONFIG;
  const config = {
    schemaVersion: 1,
    agent: { kind: d.agent.kind, command: [...d.agent.command], requireArgs: [], passEnv: [] },
    budgets: { ...d.budgets },
    verification: { commands: d.verification.commands.map((c) => [...c]), timeoutSeconds: d.verification.timeoutSeconds },
    branchPrefix: d.branchPrefix,
    protectedBranches: [],
  };

  if (Object.hasOwn(value, 'agent')) {
    const a = value.agent;
    if (!isObj(a)) bad('agent must be an object');
    else {
      checkKeys(a, ['kind', 'command', 'env', 'requireArgs', 'passEnv'], 'agent', bad);
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
            if (validEnvName(k) && deniedEnvName(k)) bad(`agent.env.${k} is not allowed (reserved: PATH, HOME, loader and option variables such as LD_*, DYLD_*, NODE_*, JAVA_*, GRADLE_*, GIT_*, SSH_*, CLAUDE_*, CODEX_*, and proxy, *_URL and *_HOST variables)`);
            else if (!validEnvName(k)) bad(`agent.env key ${JSON.stringify(k.slice(0, 40))} must be A-Z, 0-9 and "_" only`);
            else if (typeof v !== 'string' || v.length > MAX_ARG || hasControl(v)) bad(`agent.env.${k} must be a printable string of at most ${MAX_ARG} characters`);
            else env[k] = v;
          }
          config.agent.env = env;
        }
      }
      if (Object.hasOwn(a, 'requireArgs')) config.agent.requireArgs = listOf(a.requireArgs, 'agent.requireArgs', requireArgProblem, bad);
      if (Object.hasOwn(a, 'passEnv')) config.agent.passEnv = listOf(a.passEnv, 'agent.passEnv', passEnvProblem, bad);
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
          if (v.commands.length === 0) bad('verification.commands must contain at least one command');
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
    const p = branchNameProblem(value.branchPrefix);
    if (p) bad(`branchPrefix ${p}`);
    else config.branchPrefix = value.branchPrefix;
  }

  // Extra branch names the runner refuses to work on (default branches it cannot detect: no origin/HEAD, custom name).
  if (Object.hasOwn(value, 'protectedBranches')) {
    const pb = value.protectedBranches;
    if (!Array.isArray(pb)) bad('protectedBranches must be an array of branch names');
    else if (pb.length > MAX_PROTECTED) bad(`protectedBranches has more than ${MAX_PROTECTED} entries`);
    else {
      const names = [];
      pb.forEach((n, i) => {
        const p = branchNameProblem(n);
        if (p) bad(`protectedBranches[${i}] ${p}`);
        else names.push(n);
      });
      config.protectedBranches = names;
    }
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
