import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBuildFile, parseExtBlocks } from '../skill/scripts/lib/gradle.js';
import { parseVersionCatalog } from '../skill/scripts/lib/version-catalog.js';

const dep = (text, kind = 'groovy', ctx) => parseBuildFile(`dependencies {\n${text}\n}`, kind, ctx).dependencies;

test('groovy string notation', () => {
  const d = dep("  implementation 'com.squareup.retrofit2:retrofit:2.9.0'");
  assert.deepEqual(d, [{ configuration: 'implementation', group: 'com.squareup.retrofit2', name: 'retrofit', version: '2.9.0', unresolved: false, line: 2 }]);
});

test('kts string notation', () => {
  const d = dep('  implementation("io.ktor:ktor-client-core:2.3.12")', 'kts');
  assert.deepEqual(d, [{ configuration: 'implementation', group: 'io.ktor', name: 'ktor-client-core', version: '2.3.12', unresolved: false, line: 2 }]);
});

test('map notation', () => {
  const [d] = dep("  implementation group: 'a', name: 'b', version: '1'");
  assert.equal(d.group, 'a'); assert.equal(d.name, 'b'); assert.equal(d.version, '1'); assert.equal(d.unresolved, false);
});

test('project dependency', () => {
  const [d] = dep('  implementation(project(":core:data"))', 'kts');
  assert.equal(d.project, ':core:data');
  assert.equal(d.configuration, 'implementation');
  const [g] = dep("  api project(':core:ui')");
  assert.equal(g.project, ':core:ui');
});

test('ext interpolation resolved', () => {
  const text = `ext.retrofit_version = '2.9.0'
ext.versions = [okhttp: '4.12.0']
dependencies {
  implementation "com.squareup.retrofit2:retrofit:$retrofit_version"
  implementation "com.squareup.okhttp3:okhttp:\${rootProject.ext.versions.okhttp}"
}`;
  const bf = parseBuildFile(text, 'groovy');
  assert.equal(bf.dependencies[0].version, '2.9.0');
  assert.equal(bf.dependencies[0].unresolved, false);
  assert.equal(bf.dependencies[1].version, '4.12.0');
  assert.equal(bf.ext['versions.okhttp'], '4.12.0');
});

test('ext from ctx is used', () => {
  const d = dep('  implementation "a:b:$v"', 'groovy', { ext: { v: '3' } });
  assert.equal(d[0].version, '3');
});

test('unresolved stays null', () => {
  const d = dep('  implementation "x:y:${getVersion()}"');
  assert.equal(d[0].version, null);
  assert.equal(d[0].unresolved, true);
  assert.equal(d[0].name, 'y');
});

const TOML = `[versions]
retrofit = "2.9.0"
[libraries]
retrofit-core = { module = "com.squareup.retrofit2:retrofit", version.ref = "retrofit" }
[plugins]
hilt = { id = "com.google.dagger.hilt.android", version = "2.51" }
`;

test('version catalog alias', () => {
  const vc = parseVersionCatalog(TOML);
  const [d] = dep('  implementation(libs.retrofit.core)', 'kts', { versionCatalog: vc });
  assert.equal(d.group, 'com.squareup.retrofit2');
  assert.equal(d.name, 'retrofit');
  assert.equal(d.version, '2.9.0');
  assert.equal(d.alias, 'retrofit-core');
});

test('plugins block', () => {
  const vc = parseVersionCatalog(TOML);
  const text = `plugins {
  id("com.google.devtools.ksp") version "2.0.21-1.0.27"
  alias(libs.plugins.hilt)
  id 'com.android.application'
  kotlin("android")
}
apply plugin: 'kotlin-kapt'
apply(plugin = "androidx.navigation.safeargs")`;
  const bf = parseBuildFile(text, 'kts', { versionCatalog: vc });
  const ids = bf.plugins.map((p) => p.id);
  assert.deepEqual(ids, ['com.google.devtools.ksp', 'com.google.dagger.hilt.android', 'com.android.application', 'org.jetbrains.kotlin.android', 'kotlin-kapt', 'androidx.navigation.safeargs']);
  assert.equal(bf.plugins[0].version, '2.0.21-1.0.27');
  assert.equal(bf.plugins[0].line, 2);
  assert.equal(bf.plugins[1].version, '2.51');
  assert.equal(bf.plugins[2].version, null);
});

test('buildscript classpath becomes dependency', () => {
  const text = `buildscript {
  dependencies {
    classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.22"
    classpath("com.android.tools.build:gradle:8.2.0")
  }
}`;
  const bf = parseBuildFile(text, 'groovy');
  assert.deepEqual(bf.dependencies.map((d) => [d.configuration, d.name, d.version]),
    [['classpath', 'kotlin-gradle-plugin', '1.9.22'], ['classpath', 'gradle', '8.2.0']]);
});

test('android block', () => {
  const g = parseBuildFile(`android {
  namespace 'com.x.app'
  compileSdkVersion 34
  defaultConfig {
    minSdkVersion 19
    targetSdk 34
  }
  buildFeatures {
    compose true
    viewBinding false
  }
}`, 'groovy').android;
  assert.equal(g.namespace, 'com.x.app');
  assert.equal(g.minSdk, 19); assert.equal(g.targetSdk, 34); assert.equal(g.compileSdk, 34);
  assert.deepEqual(g.buildFeatures, { compose: true, viewBinding: false });
  const k = parseBuildFile(`android {
  namespace = "com.x"
  compileSdk = 35
  defaultConfig { minSdk = 24 }
  buildFeatures { compose = true; dataBinding = true }
}`, 'kts').android;
  assert.equal(k.minSdk, 24); assert.equal(k.compileSdk, 35); assert.equal(k.namespace, 'com.x');
  assert.deepEqual(k.buildFeatures, { compose: true, dataBinding: true });
  assert.equal(parseBuildFile('android { defaultConfig { minSdk 21 } }', 'groovy').android.minSdk, 21);
});

test('ignores commented-out lines', () => {
  const text = `dependencies {
  // implementation 'a:b:1'
  /* implementation 'c:d:2'
  implementation 'e:f:3' */
  implementation 'g:h:4' // trailing 'i:j:5'
}`;
  const d = parseBuildFile(text, 'groovy').dependencies;
  assert.equal(d.length, 1);
  assert.equal(d[0].name, 'h');
  assert.equal(d[0].line, 5);
});

test('handles CRLF and keeps line numbers', () => {
  const d = parseBuildFile("dependencies {\r\n  // x\r\n  implementation 'a:b:1'\r\n}\r\n", 'groovy').dependencies;
  assert.equal(d[0].line, 3);
  assert.equal(d[0].version, '1');
});

test('bom without version', () => {
  const d = dep(`  implementation(platform("androidx.compose:compose-bom:2024.10.00"))
  implementation("androidx.compose.ui:ui")`, 'kts');
  assert.equal(d[0].name, 'compose-bom');
  assert.equal(d[0].version, '2024.10.00');
  assert.equal(d[1].version, null);
  assert.equal(d[1].unresolved, false);
});

test('parseExtBlocks forms', () => {
  const e = parseExtBlocks(`ext {
  kotlin_version = "1.9.0"
  versions = [retrofit: '2.9.0', room: "2.6.1"]
}
ext.compose = '1.5'
extra["k"] = "v"
rootProject.ext.foo = 'bar'`);
  assert.deepEqual(e, { kotlin_version: '1.9.0', 'versions.retrofit': '2.9.0', 'versions.room': '2.6.1', compose: '1.5', k: 'v', foo: 'bar' });
});

test('never throws on garbage', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = ['{', '}', '(', ')', '"', "'", '$', '/', '*', ':', ' ', '\n', '\r', 'dependencies', 'android', 'plugins', 'ext', 'implementation', 'id', 'libs.', '[', ']', '='];
  for (let i = 0; i < 300; i++) {
    let s = '';
    const n = Math.floor(rnd() * 80);
    for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    for (const kind of ['groovy', 'kts']) {
      const bf = parseBuildFile(s, kind, { versionCatalog: parseVersionCatalog(TOML) });
      assert.ok(Array.isArray(bf.dependencies));
    }
  }
  for (const s of ['}}}}{{', 'dependencies {', '"""', "/* unterminated", 'implementation(', '${', null, undefined, 42]) {
    assert.ok(parseBuildFile(s, 'groovy').plugins);
  }
});

test('typesafe project accessors', () => {
  const d = dep('  implementation(projects.core.data)\n  implementation(projects.featureHome)', 'kts');
  assert.equal(d[0].project, ':core:data');
  assert.equal(d[1].project, ':feature-home');
  assert.equal(d[0].unresolved, false);
});

test('legacy ext map refs', () => {
  const text = `ext.deps = [retrofit: 'com.squareup.retrofit2:retrofit:2.9.0']
dependencies {
  implementation deps.retrofit
  implementation rootProject.ext.deps.retrofit
  implementation deps.missing
}`;
  const d = parseBuildFile(text, 'groovy').dependencies;
  assert.equal(d.length, 3);
  assert.equal(d[0].name, 'retrofit'); assert.equal(d[0].version, '2.9.0');
  assert.equal(d[1].name, 'retrofit');
  assert.equal(d[2].unresolved, true); assert.equal(d[2].group, null); assert.equal(d[2].name, null);
});

test('multiple coordinates in one statement', () => {
  const g = dep("  implementation 'a:b:1', 'c:d:2'");
  assert.deepEqual(g.map((x) => [x.name, x.version, x.line]), [['b', '1', 2], ['d', '2', 2]]);
  const k = dep('  implementation("a:b:1", "c:d:2")', 'kts');
  assert.deepEqual(k.map((x) => [x.name, x.version, x.line]), [['b', '1', 2], ['d', '2', 2]]);
});

test('multi-line call form keeps line numbers', () => {
  const d = dep('  implementation(\n    "m:n:1"\n  )\n  implementation("p:q:2")', 'kts');
  assert.deepEqual(d.map((x) => [x.name, x.line]), [['n', 2], ['q', 5]]);
});

test('bundles stay a visible unresolved row', () => {
  const d = dep('  implementation(libs.bundles.net)', 'kts', { versionCatalog: parseVersionCatalog(TOML) });
  assert.equal(d[0].unresolved, true);
  assert.equal(d[0].alias, 'bundles.net');
});

test('I2: numeric ext values resolve SDK levels', () => {
  const ext = parseExtBlocks('ext {\n  targetSdkVersion = 33\n  compileSdkVersion = 34\n  versions = [minSdk: 21]\n}\next.minSdk = 21\n');
  assert.equal(ext.targetSdkVersion, '33');
  assert.equal(ext.compileSdkVersion, '34');
  assert.equal(ext.minSdk, '21');
  assert.equal(ext['versions.minSdk'], '21');
  const a = parseBuildFile('android {\n  compileSdkVersion rootProject.ext.compileSdkVersion\n  defaultConfig {\n    minSdkVersion rootProject.ext.versions.minSdk\n    targetSdkVersion rootProject.targetSdkVersion\n  }\n}\n', 'groovy', { ext }).android;
  assert.equal(a.compileSdk, 34);
  assert.equal(a.minSdk, 21);
  assert.equal(a.targetSdk, 33);
});

test('I2: libs.versions accessors resolve SDK levels', () => {
  const vc = parseVersionCatalog('[versions]\ntargetSdk = "35"\ncompile-sdk = "36"\nminSdk = "24"\n');
  const a = parseBuildFile([
    'android {',
    '  compileSdk = libs.versions.compile.sdk.get().toInt()',
    '  defaultConfig {',
    '    targetSdk = libs.versions.targetSdk.get().toInt()',
    '    minSdk = libs.versions.minSdk.get().toInt()',
    '  }',
    '}',
  ].join('\n'), 'kts', { versionCatalog: vc }).android;
  assert.equal(a.compileSdk, 36);
  assert.equal(a.targetSdk, 35);
  assert.equal(a.minSdk, 24);
  const g = parseBuildFile('android {\n  defaultConfig {\n    targetSdkVersion libs.versions.targetSdk.get().toInteger()\n  }\n}\n', 'groovy', { versionCatalog: vc }).android;
  assert.equal(g.targetSdk, 35);
});
