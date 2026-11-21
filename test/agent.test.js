import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, newNonce, usageFloor, AGENT_DEFAULTS, effectiveAgent, agentWarnings, describeAgentArgv, buildAgentEnv, extractUsage, NO_RESTRICTIONS_WARNING } from '../skill/scripts/lib/agent.js';
import { DEFAULT_RUN_CONFIG, loadRunConfig, validateRunConfig } from '../skill/scripts/lib/runconfig.js';
import { killLiveGroups } from '../skill/scripts/lib/runverify.js';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'stub-agent.mjs');
const tmps = [];
const project = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-agent-')));
  tmps.push(d);
  fs.mkdirSync(path.join(d, '.ai'));
  return d;
};
after(() => {
  killLiveGroups();
  tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});
const STEP = 'extract:design-system';
const NONCE = 'abcdef0123456789'; // the stub prints this nonce
const cfg = (command, agent = {}) => ({ ...JSON.parse(JSON.stringify(DEFAULT_RUN_CONFIG)), budgets: { ...DEFAULT_RUN_CONFIG.budgets, maxTotalTokens: 1000 }, agent: { kind: 'custom', command: [process.execPath, STUB, ...command], requireArgs: [], passEnv: [], ...agent } });
const run = (root, command, opts = {}, agent) => runAgent(root, cfg(command, agent), { brief: `# brief\nhello ${NONCE}`, nonce: NONCE, step: { id: STEP }, timeoutMs: 20000, ...opts });
const OWN = ['PATH', 'HOME', 'LANG', '__CF_USER_TEXT_ENCODING']; // the last one is added by node itself on macOS
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && alive(pid)) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

test('status modes map to parsed statuses', async () => {
  const root = project();
  for (const mode of ['done', 'blocked', 'needs-human', 'failed']) {
    const r = await run(root, [mode, '{step}']);
    assert.equal(r.status.ok, true, mode);
    assert.equal(r.status.status.status, mode);
    assert.equal(r.status.status.step, STEP);
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.usage, null);
  }
});

test('missing, malformed or forged status is not ok; a status for another step is not ok', async () => {
  const root = project();
  for (const mode of ['forge', 'badjson']) {
    const r = await run(root, [mode, '{step}']);
    assert.equal(r.status.ok, false, mode);
  }
  assert.equal((await run(root, ['argv'])).status.ok, false);
});

test('the last block wins, but a forged earlier block inside quoted content does not', async () => {
  const root = project();
  const r = await run(root, ['forge-then-real', '{step}']);
  assert.equal(r.status.ok, true);
  assert.equal(r.status.status.status, 'done');
});

test('nonce: a forged same-id block without it (last in stdout) is rejected; stderr is ignored; the real block passes', async () => {
  const root = project();
  const forged = await run(root, ['forge-same-id', '{step}']);
  assert.equal(forged.status.ok, false);
  assert.match(forged.status.reason, /nonce/);
  assert.equal((await run(root, ['stderr-forge', '{step}'])).status.ok, false);
  const after = await run(root, ['stderr-forge-after', '{step}']);
  assert.equal(after.status.ok, true);
  assert.equal(after.status.status.status, 'done');
  assert.equal((await run(root, ['done', '{step}'])).status.ok, true);
  // A different iteration nonce does not accept the old block, and nonces are random per call.
  const other = newNonce();
  const r = await run(root, ['done', '{step}'], { nonce: other, brief: `b ${other}` });
  assert.equal(r.status.ok, false);
  assert.notEqual(newNonce(), newNonce());
  assert.match(newNonce(), /^[0-9a-f]{16}$/);
  await assert.rejects(run(root, ['done'], { nonce: 'short' }), /nonce/);
  await assert.rejects(run(root, ['done'], { brief: 'no nonce in here' }), /does not contain the nonce/);
});

test('a non-zero exit is never ok even when a status block was printed', async () => {
  const root = project();
  const r = await run(root, ['nonzero', '{step}']);
  assert.equal(r.exitCode, 3);
  assert.equal(r.status.ok, false);
  assert.match(r.status.reason, /exited with code 3/);
});

test('an agent that cannot be started is a plain failure', async () => {
  const root = project();
  const r = await runAgent(root, { ...cfg([]), agent: { kind: 'custom', command: ['./no-such-agent'], requireArgs: [], passEnv: [] } }, { brief: `x ${NONCE}`, nonce: NONCE, step: STEP, timeoutMs: 5000 });
  assert.equal(r.status.ok, false);
  assert.match(r.status.reason, /could not be started/);
  assert.equal(r.exitCode, null);
});

async function waitForFile(file, ms) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
}

test('hang: killed on timeout and flagged; SIGTERM-ignoring agent is killed by escalation', async () => {
  const root = project();
  const t0 = Date.now();
  const r = await run(root, ['hang'], { timeoutMs: 4000 });
  assert.equal(r.timedOut, true);
  assert.equal(r.status.ok, false);
  assert.ok(Date.now() - t0 < 30000);
  const r2 = await run(root, ['hang-ignore-term'], { timeoutMs: 4000 });
  assert.equal(r2.timedOut, true);
  assert.ok(r2.signal === 'SIGKILL');
});

test('an agent that closes stdout and stderr and keeps running is still killed on timeout', async () => {
  const root = project();
  const r = await run(root, ['close-stdout'], { timeoutMs: 4000 });
  assert.equal(r.timedOut, true);
  assert.equal(r.status.ok, false);
});

test('grandchildren die with the leader (after exit and on timeout)', async () => {
  const root = project();
  const pidFile = path.join(root, 'gc.pid');
  const r = await run(root, ['grandchild', pidFile, '{step}']);
  assert.equal(r.status.ok, true);
  await waitForFile(pidFile, 15000);
  assert.ok(await gone(Number(fs.readFileSync(pidFile, 'utf8'))), 'grandchild survived a normal exit');
  const pidFile2 = path.join(root, 'gc2.pid');
  const r2 = await run(root, ['grandchild-hang', pidFile2], { timeoutMs: 4000 });
  assert.equal(r2.timedOut, true);
  await waitForFile(pidFile2, 15000);
  assert.ok(await gone(Number(fs.readFileSync(pidFile2, 'utf8'))), 'grandchild survived the timeout');
});

test('flood: 48 MB of output stays bounded; the tail and the final status survive', { timeout: 60000 }, async () => {
  const root = project();
  const r = await run(root, ['flood', '48', '{step}'], { timeoutMs: 45000 });
  assert.equal(r.status.ok, true);
  assert.ok(Buffer.byteLength(r.outputTail) <= 200 * 1024);
  const log = fs.readFileSync(path.join(root, r.logPath), 'utf8');
  assert.ok(Buffer.byteLength(log) <= 200 * 1024);
});

test('stdin is closed', async () => {
  const root = project();
  const r = await run(root, ['stdin']);
  assert.match(r.outputTail, /stdin-eof/);
});

test('secrets in the output are redacted in the tail and in the log', async () => {
  const root = project();
  const r = await run(root, ['leak', '{step}']);
  assert.doesNotMatch(r.outputTail, /AKIAIOSFODNN7EXAMPLE|ghp_a1B2/);
  assert.match(r.outputTail, /REDACTED/);
  const log = fs.readFileSync(path.join(root, r.logPath), 'utf8');
  assert.doesNotMatch(log, /AKIAIOSFODNN7EXAMPLE|ghp_a1B2/);
  assert.equal(r.status.ok, true);
});

test('usage: last JSON line only, non-negative safe integers, else null', async () => {
  const root = project();
  const u = await run(root, ['usage', '{step}']);
  assert.deepEqual(u.usage, { inputTokens: 1200, outputTokens: 345, totalTokens: 1545 });
  assert.equal(u.usageFloor, 10);
  assert.equal((await run(root, ['usage-bad'])).usage, null);
  assert.equal((await run(root, ['usage-huge'])).usage, null);
  assert.equal((await run(root, ['usage-earlier'])).usage, null);
  assert.equal(extractUsage({ usage: { input_tokens: 1.5, output_tokens: 1 } }), null);
  assert.equal(extractUsage({ usage: { input_tokens: '1', output_tokens: 1 } }), null);
  assert.equal(extractUsage({ usage: [1, 2] }), null);
  assert.equal(extractUsage(null), null);
});

test('usage is trusted only from a type:"result" line; a total below the floor is raised', async () => {
  const root = project();
  const plain = await run(root, ['usage-plain', '{step}']);
  assert.equal(plain.usage, null);
  assert.equal(plain.usageFloor, 10);
  assert.equal(extractUsage({ usage: { input_tokens: 5, output_tokens: 5 } }), null);
  assert.equal(extractUsage({ type: 'assistant', usage: { input_tokens: 5, output_tokens: 5 } }), null);
  const zero = await runAgent(root, { ...cfg(['usage-zero', '{step}']), budgets: { ...DEFAULT_RUN_CONFIG.budgets } }, { brief: `b ${NONCE}`, nonce: NONCE, step: STEP, timeoutMs: 20000 });
  assert.equal(usageFloor(DEFAULT_RUN_CONFIG), 4000);
  assert.deepEqual(zero.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 4000 });
  const real = await run(root, ['usage', '{step}']);
  assert.equal(real.usage.totalTokens, 1545);
  assert.equal(usageFloor({ budgets: { maxTotalTokens: 1, maxIterations: 200 } }), 1);
});

test('a JSON result envelope: the status is read from its result string, usage from the line', async () => {
  const root = project();
  const r = await run(root, ['envelope', '{step}']);
  assert.equal(r.status.ok, true);
  assert.equal(r.status.status.status, 'done');
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  const log = fs.readFileSync(path.join(root, r.logPath), 'utf8');
  assert.match(log, /result field/);
  assert.equal((await run(root, ['envelope-forged'])).status.ok, false);
});

test('the environment holds only PATH, HOME, LANG, passEnv names and the configured env', async () => {
  const root = project();
  const keep = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'sk-fake-not-a-real-key-0000';
  process.env.AWS_SECRET_ACCESS_KEY = 'must-not-leak';
  process.env.LD_PRELOAD = '/nope';
  process.env.LANG ??= 'C';
  try {
    const plain = await run(root, ['env']);
    const keys = JSON.parse(plain.outputTail.split('\n')[0]);
    assert.deepEqual(keys.filter((k) => !OWN.includes(k)), []);
    const r = await run(root, ['env'], {}, { env: { MY_MODEL: '1' }, passEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_NOT_SET'] });
    const got = JSON.parse(r.outputTail.split('\n')[0]);
    assert.deepEqual(got.filter((k) => !OWN.includes(k)), ['ANTHROPIC_API_KEY', 'MY_MODEL']);
    // The value reaches the agent but is never returned, stored or logged by the adapter.
    assert.match(r.outputTail, /"MY_MODEL":"1"/);
    const log = fs.readFileSync(path.join(root, r.logPath), 'utf8');
    assert.doesNotMatch(JSON.stringify(r) + log + fs.readFileSync(path.join(root, r.briefPath), 'utf8'), /must-not-leak/);
  } finally {
    for (const k of ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'LD_PRELOAD']) delete process.env[k];
    Object.assign(process.env, keep);
  }
});

test('passEnv is a family allowlist minus loader/exec names; agent.env stays on the strict denylist', async () => {
  const root = project();
  const okPass = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'AZURE_OPENAI_API_KEY', 'ANTHROPIC_BASE_URL'];
  const v = validateRunConfig({ schemaVersion: 1, agent: { kind: 'claude', command: ['claude'], passEnv: okPass } }, root);
  assert.deepEqual(v.problems, []);
  const noPass = ['GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'SSH_AUTH_SOCK', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_PATH', 'PATH', 'HOME', 'JAVA_TOOL_OPTIONS', 'BASH_ENV', 'ENV', 'GIT_SSH_COMMAND', 'GOOGLE_APPLICATION_CREDENTIALS', 'ANTHROPIC_', 'lower', 'ANTHROPIC-KEY'];
  for (const bad of noPass) {
    await assert.rejects(run(root, ['env'], {}, { passEnv: [bad] }), /passEnv/, bad);
    assert.ok(validateRunConfig({ schemaVersion: 1, agent: { kind: 'claude', command: ['claude'], passEnv: [bad] } }, root).problems.some((p) => p.includes('agent.passEnv')), bad);
  }
  for (const bad of ['PATH', 'HOME', 'LANG', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'JAVA_TOOL_OPTIONS', 'GRADLE_OPTS', 'BASH_ENV', 'ENV', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'ANTHROPIC_BASE_URL', 'OPENAI_API_URL', 'HTTPS_PROXY', 'GIT_SSH_COMMAND', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'lower']) {
    await assert.rejects(run(root, ['env'], {}, { env: { [bad]: 'x' } }), /agent\.env/, bad);
    assert.ok(validateRunConfig({ schemaVersion: 1, agent: { kind: 'claude', command: ['claude'], env: { [bad]: 'x' } } }, root).problems.length > 0, bad);
  }
  process.env.MULTI_LINE_X = 'a';
  process.env.ANTHROPIC_MULTI = 'a\nb';
  try {
    await assert.rejects(run(root, ['env'], {}, { passEnv: ['ANTHROPIC_MULTI'] }), /control characters or newlines/);
  } finally {
    delete process.env.ANTHROPIC_MULTI;
    delete process.env.MULTI_LINE_X;
  }
  await assert.rejects(run(root, ['env'], {}, { env: { OK_MODEL: 'a\nb' } }), /control characters or newlines/);
  await assert.rejects(run(root, ['env'], {}, { env: { OK_MODEL: 'a\u0000b' } }), /control characters/);
  assert.throws(() => buildAgentEnv({ agent: { passEnv: 'x' } }), /array/);
});

test('the adapter enforces the same agent.env name allowlist as the config validator (defense in depth)', () => {
  assert.deepEqual(buildAgentEnv({ agent: { env: { AGENT_MODEL: 'm', CI: '1' } } }, {}), { AGENT_MODEL: 'm', CI: '1' });
  for (const bad of ['OK_NAME', 'MY_SERVICE_KEY', 'SOME_TOKEN', 'MODEL_FILE', 'FOO']) {
    assert.throws(() => buildAgentEnv({ agent: { env: { [bad]: 'x' } } }, {}), /agent\.env holds a name that is not allowed/, bad);
  }
});

test('an agent.env value longer than the 380-character consent line cap minus the name and quotes is refused at validation', () => {
  const v = (value) => validateRunConfig({ schemaVersion: 1, agent: { kind: 'claude', command: ['claude'], env: { AGENT_MODEL: value } } }, project()).problems;
  // cap = 380 - 7 - name length (AGENT_MODEL is 11 characters)
  assert.deepEqual(v('a'.repeat(362)), []);
  assert.ok(v('a'.repeat(363)).some((p) => /agent\.env\.AGENT_MODEL.*at most 362 characters/.test(p)));
  assert.ok(v('a'.repeat(380)).some((p) => /at most 362 characters/.test(p)));
});

test('a passEnv name that is set but empty or unset is simply not passed', () => {
  const env = buildAgentEnv({ agent: { passEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] } }, { PATH: '/bin', ANTHROPIC_API_KEY: '', LANG: 'C' });
  assert.deepEqual(env, { PATH: '/bin', LANG: 'C' });
  const long = buildAgentEnv({ agent: {} }, { PATH: `/a:${'b'.repeat(20000)}` });
  assert.equal(long.PATH.length > 20000, true);
  assert.throws(() => buildAgentEnv({ agent: {} }, { PATH: 'x'.repeat(40000) }), /too long/);
});

test('PEM keys and Bearer tokens printed by the agent are redacted in the adapter log and tail', async () => {
  const root = project();
  const r = await run(root, ['secrets', '{step}']);
  const log = fs.readFileSync(path.join(root, r.logPath), 'utf8');
  for (const t of [log, r.outputTail]) {
    assert.doesNotMatch(t, /MIIEpAIBAAKCAQEA1234567890|abcDEF1234567890ghijkl/);
    assert.match(t, /REDACTED/);
  }
});

test('config schema: requireArgs and passEnv are strict and capped', () => {
  const ok = validateRunConfig({ schemaVersion: 1, agent: { kind: 'claude', command: ['claude'], requireArgs: ['--allowedTools=Edit', 'plan.mode'], passEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] } }, '/p');
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.config.agent.requireArgs, ['--allowedTools=Edit', 'plan.mode']);
  assert.deepEqual(ok.config.agent.passEnv, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  const dflt = validateRunConfig({ schemaVersion: 1 }, '/p').config.agent;
  assert.deepEqual([dflt.requireArgs, dflt.passEnv], [[], []]);
  const bad = (agent) => validateRunConfig({ schemaVersion: 1, agent: { kind: 'claude', command: ['claude'], ...agent } }, '/p').problems.join('\n');
  assert.match(bad({ requireArgs: ['a b'] }), /requireArgs\[0\]/);
  assert.match(bad({ requireArgs: ['--x;rm'] }), /requireArgs\[0\]/);
  assert.match(bad({ requireArgs: ['/abs'] }), /requireArgs\[0\]/);
  assert.match(bad({ requireArgs: [1] }), /requireArgs\[0\]/);
  assert.match(bad({ requireArgs: 'x' }), /array/);
  assert.match(bad({ requireArgs: Array.from({ length: 21 }, (_, i) => `a${i}`) }), /more than 20/);
  assert.match(bad({ passEnv: Array.from({ length: 21 }, (_, i) => `A${i}`) }), /more than 20/);
  assert.match(bad({ passEnv: ['lower'] }), /passEnv\[0\]/);
  assert.match(bad({ passEnv: ['SECRET=value'] }), /passEnv\[0\]/);
  assert.match(bad({ passEnv: [`${'A'.repeat(65)}`] }), /passEnv\[0\]/);
});

test('requireArgs: every listed string must be an argv element, or the agent is not started', async () => {
  const root = project();
  await assert.rejects(run(root, ['argv'], {}, { requireArgs: ['--restricted'] }), /required argument/);
  assert.equal(fs.existsSync(path.join(root, '.ai/runs')), false, 'nothing is written when refusing');
  const r = await run(root, ['argv', '--restricted'], {}, { requireArgs: ['--restricted'] });
  assert.equal(r.exitCode, 0);
  // A value that arrives through a placeholder cannot satisfy the requirement.
  await assert.rejects(run(root, ['argv', '{step}'], {}, { requireArgs: [STEP] }), /required argument/);
});

test('warnings: unverified defaults and missing permission restrictions are reported', () => {
  const c = JSON.parse(JSON.stringify(DEFAULT_RUN_CONFIG));
  const w = agentWarnings(c);
  assert.ok(w.some((x) => /unverified/.test(x)));
  assert.ok(w.includes(NO_RESTRICTIONS_WARNING));
  assert.equal(NO_RESTRICTIONS_WARNING, 'no permission restrictions are configured for the agent');
  c.agent.requireArgs = ['--x'];
  assert.ok(!agentWarnings(c).includes(NO_RESTRICTIONS_WARNING));
  assert.equal(AGENT_DEFAULTS.claude.unverified, true);
  assert.equal(AGENT_DEFAULTS.codex.unverified, true);
  assert.equal(AGENT_DEFAULTS.claude.docs, 'check the current CLI help');
  assert.deepEqual(effectiveAgent({ agent: { kind: 'codex', command: ['codex'] } }).argv.slice(0, 2), ['codex', 'exec']);
  const over = effectiveAgent({ agent: { kind: 'claude', command: ['claude', '-p', '{brief}'] } });
  assert.equal(over.unverified, false);
  assert.match(describeAgentArgv({ agent: { kind: 'claude', command: ['claude'] } }), /^claude -p \{prompt\} --output-format json/);
});

test('the default templates validate (placeholders only, no absolute path) and reach the agent as a short fixed prompt', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.ai/run.config.json'), JSON.stringify({ schemaVersion: 1 }));
  const c = loadRunConfig(root);
  assert.deepEqual(effectiveAgent(c).argv, [...AGENT_DEFAULTS.claude.argv]);
  for (const t of Object.values(AGENT_DEFAULTS)) for (const a of t.argv) assert.ok(!a.startsWith('/'));
});

test('{brief} is the project-relative path of a real brief file; {prompt} is the fixed short prompt', async () => {
  const root = project();
  const r = await run(root, ['brief-exists', '{brief}']);
  assert.match(r.outputTail, /^brief-exists \d+/);
  assert.match(r.briefPath, /^\.ai\/runs\/[A-Za-z0-9_-]+\/brief-1\.md$/);
  assert.ok(fs.existsSync(path.join(root, r.briefPath)));
  const a = await run(root, ['argv', '{prompt}', '{maxTurns}'], { runId: 'fixed' });
  const argv = JSON.parse(a.outputTail.split('\n')[0]);
  assert.match(argv[1], /^Read \.ai\/runs\/fixed\/brief-1\.md and follow it exactly; end your final message with the status block\.$/);
  assert.equal(argv[2], '20');
  assert.ok(Buffer.byteLength(argv[1]) < 200);
});

test('brief and log numbers never overwrite an earlier iteration', async () => {
  const root = project();
  const a = await run(root, ['done', '{step}'], { runId: 'r1' });
  const b = await run(root, ['done', '{step}'], { runId: 'r1' });
  assert.equal(a.logPath, '.ai/runs/r1/agent-1.log');
  assert.equal(b.logPath, '.ai/runs/r1/agent-2.log');
  assert.ok(fs.existsSync(path.join(root, '.ai/runs/r1/brief-1.md')));
});

test('hostile {step} values are data (no shell) and numeric maxTurns is enforced', async () => {
  const root = project();
  const hostile = '$(touch pwned); `touch pwned2` && echo "x" | tee pwned3';
  for (const bad of [hostile, '../../etc/passwd', 'A:b', 'a b']) await assert.rejects(runAgent(root, cfg(['argv']), { brief: `b ${NONCE}`, nonce: NONCE, step: bad }), /step id/, bad);
  const NASTY = 'a:b';
  const r = await runAgent(root, cfg(['argv', '{step}', '{maxTurns}']), { brief: `b ${NONCE}`, nonce: NONCE, step: 'a:b', turns: 7, timeoutMs: 20000 });
  assert.deepEqual(JSON.parse(r.outputTail.split('\n')[0]), ['argv', 'a:b', '7']);
  for (const f of ['pwned', 'pwned2', 'pwned3']) assert.equal(fs.existsSync(path.join(root, f)), false);
  for (const turns of [0, -1, 1.5, '5', NaN, 201, 1e12, Infinity]) await assert.rejects(runAgent(root, cfg(['argv']), { brief: `b ${NONCE}`, nonce: NONCE, step: STEP, turns }), /turns must be/, String(turns));
  for (const step of ['-rf', '', 'a\nb', 'a'.repeat(201), '--flag', null, '../x']) await assert.rejects(runAgent(root, cfg(['argv']), { brief: `b ${NONCE}`, nonce: NONCE, step }), /step id/, String(step));
  for (const timeoutMs of [0, -5, 1.5, 'x', 1e12]) await assert.rejects(runAgent(root, cfg(['argv']), { brief: `b ${NONCE}`, nonce: NONCE, step: STEP, timeoutMs }), /timeoutMs/, String(timeoutMs));
  await assert.rejects(runAgent(root, cfg(['argv']), { brief: '', nonce: NONCE, step: STEP }), /brief/);
  await assert.rejects(runAgent(root, cfg(['argv']), { brief: `${NONCE}${'x'.repeat(300 * 1024)}`, nonce: NONCE, step: STEP }), /brief/);
  await assert.rejects(runAgent(root, cfg(['argv']), { brief: `b ${NONCE}`, nonce: NONCE, step: STEP, runId: '../x' }), /runId/);
});

test('errors are plain: no stack, no absolute path', async () => {
  const root = project();
  fs.symlinkSync(os.tmpdir(), path.join(root, '.ai', 'runs'));
  let err;
  try {
    await run(root, ['done', '{step}']);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'a symlinked .ai/runs refuses');
  assert.doesNotMatch(err.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(err.message, /\n\s+at /);
  assert.match(err.message, /^agent: /);
});

test('no .ai folder: plain refusal, and nothing runs', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-agent-noai-')));
  tmps.push(root);
  await assert.rejects(run(root, ['done', '{step}']), /no \.ai folder/);
});

test('a symlink planted into .ai during the run refuses the log (containment), the result still comes back', async () => {
  const root = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-agent-out-'));
  tmps.push(outside);
  const planter = path.join(root, 'plant.mjs');
  fs.writeFileSync(planter, `import fs from 'node:fs'; fs.symlinkSync(${JSON.stringify(outside)}, '.ai/evil'); console.log('x');`);
  const r = await runAgent(root, { ...cfg([]), agent: { kind: 'custom', command: [process.execPath, planter], requireArgs: [], passEnv: [] } }, { brief: `b ${NONCE}`, nonce: NONCE, step: STEP, timeoutMs: 20000 });
  assert.equal(r.logPath, null);
  assert.match(r.logError, /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('the log has a plain header and is written through the guarded writer', async () => {
  const root = project();
  const r = await run(root, ['done', '{step}']);
  const log = fs.readFileSync(path.join(root, r.logPath), 'utf8');
  assert.match(log, /^step: /);
  assert.match(log, /status: done/);
});
