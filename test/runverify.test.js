import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runVerification, killLiveGroups, Tail, cleanTail } from '../skill/scripts/lib/runverify.js';

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

test('a backgrounded grandchild is gone after a NORMAL exit (whole group killed)', async () => {
  const root = project();
  const pidFile = path.join(root, 'bg.pid');
  const bg = script(root, 'bg.js', `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`);
  const parent = script(root, 'p.js', `require('child_process').spawn(process.execPath,[${JSON.stringify(bg)}],{stdio:'ignore'}).unref();setTimeout(()=>{},400)`);
  const r = await runVerification(root, cfg(node(parent)), { timeoutMs: 20000 });
  assert.equal(r.ok, true);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(await waitGone(pid, 8000), true);
});

test('process-level cleanup is installed once, idempotent, and kills live groups', async () => {
  const root = project();
  const before = [process.listenerCount('exit'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const hang = script(root, 'h.js', 'setInterval(()=>{},1000)');
  const run = runVerification(root, cfg(node(hang)), { timeoutMs: 60000 });
  await new Promise((r) => setTimeout(r, 400));
  killLiveGroups();
  killLiveGroups();
  const r = await run;
  assert.equal(r.ok, false);
  await runVerification(root, cfg(node(script(root, 'ok.js', '1'))), { timeoutMs: 20000 });
  const after = [process.listenerCount('exit'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  for (let i = 0; i < 3; i++) assert.ok(after[i] - before[i] <= 1, 'at most one handler per event');
  assert.doesNotThrow(() => killLiveGroups());
});

test('an empty command list is not ok', async () => {
  const root = project();
  const r = await runVerification(root, { verification: { commands: [], timeoutSeconds: 5 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no verification commands/);
});

test('a tail that starts inside a PEM block is scrubbed; plain repeated output is kept', async () => {
  const root = project();
  const body = Array.from({ length: 400 }, (_, i) => crypto.createHash('sha256').update(String(i)).digest('base64').replace(/=+$/, '') + crypto.createHash('md5').update(String(i)).digest('base64').slice(0, 20)).join('\n');
  const s = script(root, 'pem.js', `console.log("-----BEGIN PRIVATE KEY-----");console.log(${JSON.stringify(body)});console.log("-----END PRIVATE KEY-----");console.error("Error: done");process.exit(1)`);
  const r = await runVerification(root, cfg(node(s)), { timeoutMs: 20000 });
  const sample = crypto.createHash('sha256').update('399').digest('base64').slice(0, 30);
  assert.ok(!r.results[0].tail.includes(sample), 'key body must not appear');
  assert.match(r.results[0].tail, /Error: done/);
  const flood = script(root, 'flood.js', 'const l="x".repeat(99)+"\\n";for(let i=0;i<52000;i++)process.stdout.write(l);process.exit(1)');
  const f = await runVerification(root, cfg(node(flood)), { timeoutMs: 30000 });
  assert.ok(f.results[0].tail.length > 15 * 1024);
});

test('a Bearer token and an Authorization header printed by a command are redacted', async () => {
  const root = project();
  const s = script(root, 'b.js', 'console.log("Authorization: Bearer abcdef1234567890abcdef");console.log("curl -H \\"authorization: token ghx1234567890abcd\\"");process.exit(1)');
  const r = await runVerification(root, cfg(node(s)), { timeoutMs: 20000 });
  assert.doesNotMatch(r.results[0].tail, /abcdef1234567890abcdef|ghx1234567890abcd/);
});

function fakeKeys() {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const wrap = (label, b64) => `-----BEGIN ${label}-----\n${b64.match(/.{1,70}/g).join('\n')}\n-----END ${label}-----\n`;
  return {
    pkcs1: rsa.export({ type: 'pkcs1', format: 'pem' }),
    pkcs8: rsa.export({ type: 'pkcs8', format: 'pem' }),
    ec: ec.export({ type: 'sec1', format: 'pem' }),
    encrypted: rsa.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }),
    openssh: wrap('OPENSSH PRIVATE KEY', crypto.randomBytes(1200).toString('base64')),
    shortLast: wrap('PRIVATE KEY', crypto.randomBytes(1000).toString('base64').slice(0, 1020 - 4 * 3) + 'Zg=='),
  };
}

test('a tail window cut at EVERY byte offset of the first 2 KB of a key never leaks the key body', () => {
  const cap = 20 * 1024;
  for (const [name, key] of Object.entries(fakeKeys())) {
    const bodyLines = key.split('\n').filter((l) => /^[A-Za-z0-9+/=]{16,}$/.test(l));
    assert.ok(bodyLines.length >= 2, name);
    const filler = Buffer.from('build log line 1\nbuild log line 2\n');
    const allAfter = Buffer.from(Array.from({ length: 3000 }, (_, i) => `ok line ${i}\n`).join(''));
    for (let k = 0; k <= 2048; k++) {
      const keyBuf = Buffer.from(key);
      const after = allAfter.subarray(0, Math.max(0, cap + k - keyBuf.length));
      const t = new Tail();
      t.push(Buffer.concat([filler, keyBuf, after]));
      const out = t.text(); // redact() can only remove more
      for (const l of bodyLines) assert.ok(!out.includes(l.slice(0, 12)), `${name} offset ${k} leaked a body line`);
    }
  }
});

test('output without a key is untouched, including leading word-like lines', () => {
  const t = new Tail();
  const text = Array.from({ length: 400 }, (_, i) => (i % 3 === 0 ? 'BUILD' : `Task :app:compile${i} FAILED ok`)).join('\n') + '\n';
  t.push(Buffer.from(text));
  assert.equal(cleanTail(t.text()), text);
  const big = new Tail();
  big.push(Buffer.from(text.repeat(5)));
  const out = cleanTail(big.text());
  assert.ok(out.length > 15 * 1024);
});
