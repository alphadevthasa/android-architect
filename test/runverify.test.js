import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runVerification } from '../skill/scripts/lib/runverify.js';

const tmps = [];
const project = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-verify-')));
  tmps.push(d);
  return d;
};
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const script = (root, name, body) => {
  fs.writeFileSync(path.join(root, name), body);
  return name;
};
const cfg = (...commands) => ({ verification: { commands, timeoutSeconds: 60 } });
const node = (name, ...rest) => [process.execPath, name, ...rest];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitGone = async (pid, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && alive(pid)) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

test('a passing command is ok with an empty signature; a failing one stops the list', async () => {
  const root = project();
  const ok = script(root, 'ok.js', 'console.log("fine")');
  const bad = script(root, 'bad.js', 'console.error("Error: boom 42"); process.exit(3)');
  const never = script(root, 'never.js', 'require("fs").writeFileSync("never-ran","1")');
  const pass = await runVerification(root, cfg(node(ok)), { timeoutMs: 20000 });
  assert.equal(pass.ok, true);
  assert.equal(pass.results.length, 1);
  assert.equal(pass.results[0].exitCode, 0);
  assert.equal(pass.results[0].timedOut, false);
  assert.equal(pass.results[0].signature, '');
  assert.match(pass.results[0].tail, /fine/);
  const fail = await runVerification(root, cfg(node(bad), node(never)), { timeoutMs: 20000 });
  assert.equal(fail.ok, false);
  assert.equal(fail.results.length, 1);
  assert.equal(fail.results[0].exitCode, 3);
  assert.match(fail.results[0].signature, /^[0-9a-f]{16}$/);
  assert.equal(fs.existsSync(path.join(root, 'never-ran')), false);
});

test('a command that exceeds the timeout is killed and flagged', async () => {
  const root = project();
  const hang = script(root, 'hang.js', 'setInterval(()=>{},1000)');
  const t0 = Date.now();
  const r = await runVerification(root, cfg(node(hang)), { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].timedOut, true);
  assert.ok(Date.now() - t0 < 8000);
  assert.ok(r.results[0].exitCode !== 0);
});

test('process-group kill: a grandchild that sleeps is gone after the timeout, even if it ignores SIGTERM', async () => {
  const root = project();
  const pidFile = path.join(root, 'grand.pid');
  const stubborn = script(
    root,
    'grand.js',
    `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
  );
  const parent = script(
    root,
    'parent.js',
    `const {spawn}=require('child_process');spawn(process.execPath,[${JSON.stringify(stubborn)}],{stdio:'ignore'});setInterval(()=>{},1000)`,
  );
  const r = await runVerification(root, cfg(node(parent)), { timeoutMs: 1500 });
  assert.equal(r.results[0].timedOut, true);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 1);
  assert.equal(await waitGone(pid, 8000), true, 'grandchild must be gone');
});

test('5 MB of output is bounded to 20 KB', async () => {
  const root = project();
  const big = script(root, 'big.js', 'const l="x".repeat(99)+"\\n";for(let i=0;i<52000;i++)process.stdout.write(l);console.error("Error: tail-marker");process.exit(1)');
  const r = await runVerification(root, cfg(node(big)), { timeoutMs: 30000 });
  const tail = r.results[0].tail;
  assert.ok(tail.length <= 20 * 1024, String(tail.length));
  assert.ok(tail.length > 15 * 1024);
  assert.match(tail, /tail-marker/);
});

test('a secret printed by a command is redacted in the tail', async () => {
  const root = project();
  const s = script(root, 's.js', 'console.log("token = AKIAIOSFODNN7EXAMPLE");console.log("key ghp_abcdefghijklmnopqrstuvwxyz0123456789");process.exit(1)');
  const r = await runVerification(root, cfg(node(s)), { timeoutMs: 20000 });
  assert.doesNotMatch(r.results[0].tail, /AKIAIOSFODNN7EXAMPLE|ghp_abcdefghij/);
  assert.match(r.results[0].tail, /REDACTED/);
});

test('control characters and escape sequences are stripped from the tail', async () => {
  const root = project();
  const s = script(root, 's.js', 'process.stdout.write("a\\u001b[31mred\\u001b[0m\\u202e b\\r\\n");process.exit(1)');
  const r = await runVerification(root, cfg(node(s)), { timeoutMs: 20000 });
  assert.doesNotMatch(r.results[0].tail, /[\u001b‮\r]/);
  assert.match(r.results[0].tail, /red/);
});

test('signature: equal for failures differing only in numbers/paths/hex/timestamps, different for different errors', async () => {
  const root = project();
  const mk = (name, line) => script(root, name, `console.log(${JSON.stringify('noise')});console.error(${JSON.stringify(line)});process.exit(1)`);
  const sig = async (name, line) => (await runVerification(root, cfg(node(mk(name, line))), { timeoutMs: 20000 })).results[0].signature;
  const a = await sig('a.js', 'e: /Users/alice/proj/app/src/Main.kt:12:5 error: Unresolved reference: foo 2026-11-20T10:11:12Z id 0xdeadbeef');
  const b = await sig('b.js', 'e: /var/folders/zz/T/other/app/src/Main.kt:340:9 error: Unresolved reference: foo 2027-01-02T01:02:03Z id 0xcafef00d');
  const c = await sig('c.js', 'e: /Users/alice/proj/app/src/Main.kt:12:5 error: Type mismatch: bar');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
  const noMatch = await sig('d.js', 'just a plain failure');
  assert.match(noMatch, /^[0-9a-f]{16}$/);
});

test('shell is never used: a metacharacter argument is data', async () => {
  const root = project();
  const echo = script(root, 'echo.js', 'console.log(JSON.stringify(process.argv.slice(2)))');
  const r = await runVerification(root, cfg(node(echo, '; touch x', '$(touch y)', '`touch z`')), { timeoutMs: 20000 });
  assert.equal(r.ok, true);
  for (const f of ['x', 'y', 'z']) assert.equal(fs.existsSync(path.join(root, f)), false);
  assert.match(r.results[0].tail, /touch x/);
});

test('the child sees only the allowlisted environment, stdin is closed, cwd is the project root', async () => {
  const root = project();
  const probe = script(
    root,
    'probe.js',
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.stringify({keys:Object.keys(process.env).sort(),cwd:process.cwd(),stdin:s}))})',
  );
  const saved = { SECRET_THING: process.env.SECRET_THING, JAVA_HOME: process.env.JAVA_HOME, GIT_DIR: process.env.GIT_DIR, NODE_OPTIONS: process.env.NODE_OPTIONS };
  process.env.SECRET_THING = 'hunter2hunter2';
  process.env.JAVA_HOME = '/opt/java';
  process.env.GIT_DIR = '/x';
  try {
    const r = await runVerification(root, cfg(node(probe)), { timeoutMs: 20000 });
    const out = JSON.parse(r.results[0].tail.trim().split('\n').pop());
    const allowed = ['PATH', 'HOME', 'LANG', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME', 'CI'];
    for (const k of out.keys) assert.ok(allowed.includes(k) || k === '__CF_USER_TEXT_ENCODING' || k === 'LC_CTYPE', `unexpected env ${k}`);
    assert.ok(out.keys.includes('CI') && out.keys.includes('JAVA_HOME'));
    assert.ok(!out.keys.includes('SECRET_THING') && !out.keys.includes('GIT_DIR') && !out.keys.includes('NODE_OPTIONS'));
    assert.equal(fs.realpathSync(out.cwd), root);
    assert.equal(out.stdin, '');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('a missing executable fails without throwing', async () => {
  const root = project();
  const r = await runVerification(root, cfg(['./definitely-missing-gradlew', 'x']), { timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].exitCode, null);
  assert.match(r.results[0].tail, /could not be started/);
  assert.equal(r.results[0].tail.includes(root), false);
});
