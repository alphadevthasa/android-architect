import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as rungit from '../skill/scripts/lib/rungit.js';
import { isBuildPath, verificationScripts, buildGate, changedPaths, stopPresent, includeBuildDirs, ignoredBuildMap } from '../skill/scripts/lib/runguard.js';

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

test('includeBuild directories from settings files: inside the repo gated, outside ignored, hostile text bounded', () => {
  const d = repo({
    'settings.gradle.kts': 'pluginManagement { includeBuild("../shared-logic") }\nincludeBuild("plugins/Conv")\nincludeBuild(file(\'tools/p\'))\nincludeBuild(\n',
    'plugins/Conv/src/A.kt': 'a', 'tools/p/b.kt': 'b', 'src/c.kt': 'c',
  });
  assert.deepEqual([...includeBuildDirs(d, d)].sort(), ['plugins/conv', 'tools/p']);
  put(d, 'plugins/Conv/src/A.kt', 'evil');
  put(d, 'tools/p/new.kt', 'evil');
  put(d, 'src/c.kt', 'fine');
  assert.deepEqual(buildGate(rungit, d, CFG).files, ['plugins/Conv/src/A.kt', 'tools/p/new.kt']);
  // hostile settings: one huge line, many lines, NUL bytes: no hang, no crash
  put(d, 'settings.gradle', `${'includeBuild("x'.repeat(200000)}\n${'\n'.repeat(100000)}\0`);
  const t0 = Date.now();
  includeBuildDirs(d, d);
  assert.ok(Date.now() - t0 < 2000);
  put(d, 'settings.gradle', 'x'.repeat(300 * 1024)); // over the size cap: skipped
  assert.doesNotThrow(() => includeBuildDirs(d, d));
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
