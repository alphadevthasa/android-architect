import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as rungit from '../skill/scripts/lib/rungit.js';
import { blobHasCredentials } from '../skill/scripts/lib/rungit.js';
import { isBuildPath, verificationScripts, buildGate, changedPaths, stopPresent, includeBuildDirs, ignoredBuildMap, GateUnsure } from '../skill/scripts/lib/runguard.js';

const tmps = [];
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
function repo(files = { 'README.md': '# t\n' }) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa-guard-')));
  tmps.push(d);
  g(d, 'init', '-q', '-b', 'main');
  for (const [k, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, k)), { recursive: true });
    fs.writeFileSync(path.join(d, k), v);
  }
  g(d, 'add', '-A');
  g(d, 'commit', '-q', '-m', 'init');
  return d;
}
const put = (d, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
  fs.writeFileSync(path.join(d, rel), text);
};
const CFG = { verification: { commands: [['./gradlew', 'test'], ['node', './tools/Verify.js']] } };

test('isBuildPath: build-execution set, any case, any depth', () => {
  for (const p of ['gradlew', 'GRADLEW', 'gradlew.bat', 'app/Build.Gradle.KTS', 'x/build.gradle', 'settings.gradle.kts', 'Settings.Gradle', 'gradle/wrapper/gradle-wrapper.jar', 'app/Gradle/Wrapper/x.properties', 'BuildSrc/src/X.kt', 'a/b/buildSrc/build.gradle.kts', 'gradle.properties', 'feature/x/gradle.properties', 'package.json', 'web/package.json', '.npmrc', 'scripts/Run.SH', 'Makefile', 'a\\gradlew', 'build-logic/src/main/kotlin/Conv.kt', 'x/Build-Logic/a.kt', 'pom.xml', 'sub/.mvn/jvm.config', 'gradle/verification-metadata.xml', 'gradle/libs.versions.toml', 'node_modules/.bin/x']) {
    assert.equal(isBuildPath(p), true, p);
  }
  for (const p of ['src/a.kt', 'gradlew.txt', 'docs/gradle.md', 'wrapper/x.kt', 'README.md']) assert.equal(isBuildPath(p), false, p);
  assert.equal(isBuildPath('tools/verify.js', verificationScripts(CFG)), true);
  assert.equal(isBuildPath('TOOLS/Verify.JS', verificationScripts(CFG)), true);
  assert.equal(isBuildPath('other/verify.js', verificationScripts(CFG)), false);
});

test('changedPaths lists modified, untracked (every file) and deleted paths', () => {
  const d = repo({ 'a.txt': 'a', 'gone.txt': 'g' });
  put(d, 'a.txt', 'b');
  put(d, 'new/dir/x.kt', 'x');
  fs.rmSync(path.join(d, 'gone.txt'));
  assert.deepEqual(changedPaths(rungit, d).sort(), ['a.txt', 'gone.txt', 'new/dir/x.kt']);
});

test('buildGate: nothing build-related -> null; matches nested, case variants, symlinks, deletions', () => {
  const d = repo({ gradlew: '#!/bin/sh\n', 'app/build.gradle.kts': 'plugins {}\n', 'README.md': 'r' });
  put(d, 'src/a.kt', 'x');
  assert.equal(buildGate(rungit, d, CFG), null);
  put(d, 'feature/x/Build.Gradle.Kts', 'evil');
  put(d, 'BuildSrc/y.kt', 'evil');
  put(d, 'tools/Verify.js', 'evil');
  fs.symlinkSync('/etc/hosts', path.join(d, 'gradle.properties'));
  fs.rmSync(path.join(d, 'gradlew')); // a deleted build file counts
  const gate = buildGate(rungit, d, CFG);
  assert.deepEqual(gate.files, ['BuildSrc/y.kt', 'feature/x/Build.Gradle.Kts', 'gradle.properties', 'gradlew', 'tools/Verify.js']);
  assert.equal(gate.count, 5);
  assert.match(gate.hash, /^[0-9a-f]{64}$/);
});

test('buildGate: approval binds to the exact content and the exact set of files', () => {
  const d = repo();
  put(d, 'build.gradle', 'one');
  const first = buildGate(rungit, d, CFG);
  assert.equal(buildGate(rungit, d, CFG, [first.hash]), null);
  assert.equal(buildGate(rungit, d, CFG, ['0'.repeat(64)]).hash, first.hash);
  put(d, 'build.gradle', 'two'); // edited after the approval
  const second = buildGate(rungit, d, CFG, [first.hash]);
  assert.ok(second && second.hash !== first.hash);
  put(d, 'build.gradle', 'one');
  put(d, 'extra.sh', 'echo');
  assert.ok(buildGate(rungit, d, CFG, [first.hash]), 'a further build file invalidates it');
});

test('stopPresent: any entry type counts, a missing file does not', () => {
  const d = repo({ '.ai/x': '1' });
  assert.equal(stopPresent(d), false);
  fs.symlinkSync('/nonexistent', path.join(d, '.ai/STOP'));
  assert.equal(stopPresent(d), true);
});

test('includeBuild directories from settings files: inside the repo gated, outside ignored', () => {
  const d = repo({
    'settings.gradle.kts': 'pluginManagement { includeBuild("../shared-logic") }\nincludeBuild("plugins/Conv")\nincludeBuild(file(\'tools/p\'))\nincludeBuild(\n  "next/line"\n)\nval includeBuilds = 1\n',
    'plugins/Conv/src/A.kt': 'a', 'tools/p/b.kt': 'b', 'src/c.kt': 'c',
  });
  assert.deepEqual([...includeBuildDirs(d, d)].sort(), ['next/line', 'plugins/conv', 'tools/p']);
  put(d, 'plugins/Conv/src/A.kt', 'evil');
  put(d, 'tools/p/new.kt', 'evil');
  put(d, 'src/c.kt', 'fine');
  assert.deepEqual(buildGate(rungit, d, CFG).files, ['plugins/Conv/src/A.kt', 'tools/p/new.kt']);
});

test('includeBuild fails closed: variables, path chains, interpolation, unreadable or oversized settings, 20k occurrences', () => {
  const bad = ['val p = "x"\nincludeBuild(p)\n', 'includeBuild(rootDir.resolve("a").resolve("b"))\n', 'includeBuild("a/$x")\n', 'includeBuild("a" + "b")\n', 'includeBuild(file(x))\n', 'includeBuild\n'];
  for (const text of bad) {
    const d = repo({ 'settings.gradle': text });
    assert.throws(() => includeBuildDirs(d, d), (e) => e instanceof GateUnsure && e.needsHuman && /includeBuild/.test(e.message), text);
  }
  let d = repo({ 'settings.gradle': 'x'.repeat(300 * 1024) });
  assert.throws(() => includeBuildDirs(d, d), GateUnsure);
  d = repo({ 'settings.gradle': 'includeBuild("a")\n'.repeat(20000) });
  const t0 = Date.now();
  assert.throws(() => includeBuildDirs(d, d), GateUnsure);
  assert.ok(Date.now() - t0 < 1000, 'bounded');
  d = repo({ 'settings.gradle': 'includeBuild("a")\n' });
  fs.chmodSync(path.join(d, 'settings.gradle'), 0);
  if (process.getuid?.() !== 0) assert.throws(() => includeBuildDirs(d, d), /cannot be read/);
  fs.chmodSync(path.join(d, 'settings.gradle'), 0o644);
});

test('includeBuild: a dir named ..dot is inside, a symlinked dir is also added by its real path', () => {
  const d = repo({ 'settings.gradle': 'includeBuild("..dot")\nincludeBuild("link")\nincludeBuild("../out")\n', '..dot/a.kt': 'a', 'real/b.kt': 'b' });
  fs.symlinkSync('real', path.join(d, 'link'));
  assert.deepEqual([...includeBuildDirs(d, d)].sort(), ['..dot', 'link', 'real']);
});

test('monorepo subdirectory root: includeBuild dirs are top-relative and ignored files under them gate', () => {
  const d = repo({ 'proj/settings.gradle.kts': 'includeBuild("plugins")\n', 'proj/plugins/a.kt': 'a', '.gitignore': '*.so\n', 'proj/src/x.kt': 'x' });
  const root = path.join(d, 'proj');
  put(d, 'proj/plugins/x.so', 'evil');
  const base = ignoredBuildMap(rungit, root, includeBuildDirs(d, root));
  assert.deepEqual([...base.keys()], ['proj/plugins/x.so']);
  put(d, 'proj/plugins/y.so', 'evil2');
  const gate = buildGate(rungit, root, CFG, [], base);
  assert.deepEqual(gate.files, ['proj/plugins/y.so', 'proj/plugins/a.kt'].sort().filter((f) => f.endsWith('y.so')));
});

test('nested repositories: deep names match; a truncated listing fails closed', () => {
  const d = repo();
  fs.mkdirSync(path.join(d, 'vend/n'), { recursive: true });
  g(path.join(d, 'vend/n'), 'init', '-q');
  put(d, 'vend/n/a/b/c/d/e/build-logic/X.kt', 'x');
  assert.deepEqual(buildGate(rungit, d, CFG).files, ['vend/n/a/b/c/d/e/build-logic/X.kt']);
  for (let i = 0; i < 5100; i++) fs.writeFileSync(path.join(d, 'vend/n', `f${i}.txt`), '');
  put(d, 'vend/n/z/gradlew', 'x');
  assert.throws(() => buildGate(rungit, d, CFG), (e) => e instanceof GateUnsure && /nested repository is too large/.test(e.message));
  fs.rmSync(path.join(d, 'vend/n'), { recursive: true });
  fs.mkdirSync(path.join(d, 'vend/n'), { recursive: true });
  g(path.join(d, 'vend/n'), 'init', '-q');
  let deep = 'vend/n';
  for (let i = 0; i < 14; i++) deep += '/d';
  put(d, `${deep}/gradlew`, 'x');
  assert.throws(() => buildGate(rungit, d, CFG), GateUnsure, 'deeper than the walk limit');
});

test('node_modules/.bin symlink targets are digested; outside or dangling targets fail closed; ignored verification scripts gate', () => {
  const d = repo({ '.gitignore': 'node_modules/\ntools/\n', 'src/a.kt': 'a' });
  put(d, 'node_modules/pkg/bin/cli.js', 'one');
  fs.mkdirSync(path.join(d, 'node_modules/.bin'), { recursive: true });
  fs.symlinkSync('../pkg/bin/cli.js', path.join(d, 'node_modules/.bin/cli'));
  const base = ignoredBuildMap(rungit, d);
  assert.deepEqual([...base.keys()].sort(), ['node_modules/.bin/cli', 'node_modules/pkg/bin/cli.js']);
  put(d, 'node_modules/pkg/bin/cli.js', 'two'); // the ignored target the symlink runs
  const gate = buildGate(rungit, d, CFG, [], base);
  assert.deepEqual(gate.files, ['node_modules/pkg/bin/cli.js']);
  fs.symlinkSync('/etc/hosts', path.join(d, 'node_modules/.bin/out'));
  assert.throws(() => ignoredBuildMap(rungit, d), (e) => e instanceof GateUnsure && /outside the repository/.test(e.message));
  fs.rmSync(path.join(d, 'node_modules/.bin/out'));
  fs.symlinkSync('../nope.js', path.join(d, 'node_modules/.bin/dangling'));
  assert.throws(() => ignoredBuildMap(rungit, d), GateUnsure);
  fs.rmSync(path.join(d, 'node_modules/.bin/dangling'));
  put(d, 'tools/Verify.js', 'ignored script named by the verification argv');
  assert.ok(buildGate(rungit, d, CFG, [], base).files.includes('tools/Verify.js'));
});

test('unreadable build files fail closed with a plain reason', () => {
  if (process.getuid?.() === 0) return;
  const d = repo();
  put(d, 'build.gradle', 'x');
  fs.chmodSync(path.join(d, 'build.gradle'), 0);
  assert.throws(() => buildGate(rungit, d, CFG), (e) => e instanceof GateUnsure && /cannot be checked \(EACCES\)/.test(e.message) && !e.message.includes(d));
  fs.chmodSync(path.join(d, 'build.gradle'), 0o644);
});

test('blobHasCredentials: whole blob, UTF-16, NUL density, latin1', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----\n';
  assert.equal(blobHasCredentials(Buffer.from(`${'a\n'.repeat(300 * 1024)}${key}`)), true, 'past 256 KB');
  assert.equal(blobHasCredentials(Buffer.concat([Buffer.from([0]), Buffer.from(`text ${key}`)])), true, 'a NUL at the start does not hide it');
  assert.equal(blobHasCredentials(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(key, 'utf16le')])), true, 'UTF-16 LE with BOM');
  assert.equal(blobHasCredentials(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(key, 'utf16le').swap16()])), true, 'UTF-16 BE with BOM');
  assert.equal(blobHasCredentials(Buffer.concat([Buffer.from([0xe9, 0xff]), Buffer.from('Authorization: Bearer abcdef0123456789abcdef0123456789')])), true, 'invalid utf8 is also read as latin1');
  assert.equal(blobHasCredentials(Buffer.concat([Buffer.alloc(1000), Buffer.from('AKIAIOSFODNN7EXAMPLE')])), false, 'dense NULs are binary');
  assert.equal(blobHasCredentials(Buffer.from('plain code\n')), false);
});
test('ignored build code: only new or changed ignored build files trigger (baseline), listing is bounded', () => {
  const d = repo({ '.gitignore': 'build/\nnode_modules/\n', 'src/a.kt': 'a' });
  put(d, 'node_modules/.bin/old', 'ok');
  put(d, 'node_modules/pkg/package.json', '{}');
  put(d, 'node_modules/pkg/build.gradle', 'x');
  const base = ignoredBuildMap(rungit, d);
  assert.deepEqual([...base.keys()], ['node_modules/.bin/old'], 'other node_modules content is not listed');
  assert.equal(buildGate(rungit, d, CFG, [], base), null);
  put(d, 'build/x.sh', 'evil');
  put(d, 'node_modules/.bin/x', 'evil');
  const gate = buildGate(rungit, d, CFG, [], base);
  assert.deepEqual(gate.files, ['build/x.sh', 'node_modules/.bin/x']);
  assert.equal(buildGate(rungit, d, CFG, [gate.hash], base), null);
  assert.ok(buildGate(rungit, d, CFG, [], null).files.includes('node_modules/.bin/old'), 'no baseline: all count');
  for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(d, `build/f${i}.sh`), '');
  assert.throws(() => ignoredBuildMap(rungit, d), (e) => e.needsHuman === true && /ignored build files/.test(e.message));
});

test('nested repositories are descended; a symlink to build code matches by its target; mode and large files change the hash', () => {
  const d = repo();
  fs.mkdirSync(path.join(d, 'vendor/lib'), { recursive: true });
  g(path.join(d, 'vendor/lib'), 'init', '-q');
  put(d, 'vendor/lib/gradlew', 'x');
  put(d, 'vendor/lib/src/a.kt', 'x');
  assert.deepEqual(buildGate(rungit, d, CFG).files, ['vendor/lib/gradlew']);
  fs.symlinkSync('vendor/lib/gradlew', path.join(d, 'harmless'));
  assert.ok(buildGate(rungit, d, CFG).files.includes('harmless'));
  const h1 = buildGate(rungit, d, CFG).hash;
  fs.chmodSync(path.join(d, 'vendor/lib/gradlew'), 0o755);
  assert.notEqual(buildGate(rungit, d, CFG).hash, h1, 'the mode is part of the digest');
  const big = path.join(d, 'build.gradle');
  const buf = Buffer.alloc(17 * 1024 * 1024, 1);
  fs.writeFileSync(big, buf);
  const h2 = buildGate(rungit, d, CFG).hash;
  buf[buf.length - 1] = 2;
  fs.writeFileSync(big, buf);
  assert.notEqual(buildGate(rungit, d, CFG).hash, h2, 'a change at the end of a large file is seen');
});
