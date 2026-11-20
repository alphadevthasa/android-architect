import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { detectStack } from '../skill/scripts/lib/detect.js';
import { renderProfileMarkdown } from '../skill/scripts/lib/report.js';
import { renderKnowledge } from '../skill/scripts/lib/knowledge.js';
import { discoverModules } from '../skill/scripts/lib/modules.js';
import { listFiles } from '../skill/scripts/lib/walk.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => path.join(here, 'fixtures', n);
const catalog = loadCatalog();
const insecure = detectStack(fixture('insecure-app'), catalog);
const ids = (p) => p.security.findings.map((f) => f.id);

test('insecure-app yields exactly the expected signal ids', () => {
  assert.deepEqual(new Set(ids(insecure)), new Set([
    'cleartext-traffic', 'exported-component', 'allow-backup', 'minify-disabled-release', 'webview-js-interface', 'sensitive-log',
  ]));
});

test('false positives are not reported', () => {
  assert.ok(!ids(insecure).includes('debuggable-release'), 'debuggable in debug only');
  assert.equal(ids(insecure).filter((i) => i === 'exported-component').length, 1);
  const exported = insecure.security.findings.find((f) => f.id === 'exported-component');
  assert.match(exported.detail, /service/);
  assert.equal(ids(insecure).filter((i) => i === 'sensitive-log').length, 1);
  const log = insecure.security.findings.find((f) => f.id === 'sensitive-log');
  const src = fs.readFileSync(path.join(fixture('insecure-app'), log.file), 'utf8').split('\n');
  assert.match(src[log.line - 1], /token=/);
});

test('every finding has a real line and is sorted by severity, file, line', () => {
  const order = { high: 0, medium: 1, low: 2 };
  const fs_ = insecure.security.findings;
  for (const f of fs_) assert.ok(Number.isInteger(f.line) && f.line >= 1, `${f.id} line`);
  for (let i = 1; i < fs_.length; i++) {
    const a = fs_[i - 1];
    const b = fs_[i];
    const k = (x) => [order[x.severity], x.file, x.line];
    assert.ok(order[a.severity] < order[b.severity] || (order[a.severity] === order[b.severity] && (a.file < b.file || (a.file === b.file && a.line <= b.line))), `${k(a)} before ${k(b)}`);
  }
});

test('modern-compose reports only its exported non-launcher activity', () => {
  const p = detectStack(fixture('modern-compose'), catalog);
  assert.deepEqual(p.security.findings.map((f) => [f.id, f.severity, f.file, f.line]), [
    ['exported-component', 'medium', 'app/src/main/AndroidManifest.xml', 4],
  ]);
});

test('secrets fixture: hardcoded-secret detail is a kind, never a value', () => {
  const p = detectStack(fixture('secrets'), catalog);
  const hits = p.security.findings.filter((f) => f.id === 'hardcoded-secret');
  assert.ok(hits.length >= 2);
  for (const h of hits) {
    assert.equal(h.severity, 'high');
    assert.match(h.detail, /^[a-z]+(-[a-z]+)*$/);
    assert.ok(!h.detail.includes('fake-'), 'detail must not contain a fixture value');
  }
});

test('Markdown profile and architecture-current carry the security sections', () => {
  const md = renderProfileMarkdown(insecure, catalog);
  assert.ok(md.includes('## Security'));
  assert.match(md, /- \[high\] cleartext-traffic: src\/main\/AndroidManifest\.xml:\d+ \(/);
  const modules = discoverModules(fixture('insecure-app'), listFiles(fixture('insecure-app')));
  const meta = { date: '2026-11-19', commit: null, catalogVersion: catalog.catalogVersion };
  const arch = renderKnowledge(insecure, modules, catalog, meta)['knowledge/architecture-current.md'];
  assert.ok(arch.includes('## Security signals'));
  assert.match(arch, /high: 1, medium: 3, low: 2/);
});

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('release-block parsing: KTS forms, debuggable in release, nested braces', () => {
  const dir = project({
    'build.gradle.kts': [
      'plugins { id("com.android.application") }',
      'android {',
      '  buildTypes {',
      '    debug { isDebuggable = true }',
      '    getByName("release") {',
      '      // isDebuggable = true',
      '      isMinifyEnabled = false',
      '      proguardFiles(getDefaultProguardFile("x"))',
      '      isDebuggable = true',
      '    }',
      '    named("staging") { isMinifyEnabled = false }',
      '  }',
      '}',
    ].join('\n'),
  });
  try {
    const f = detectStack(dir, catalog).security.findings;
    assert.deepEqual(f.map((x) => [x.id, x.line]), [['debuggable-release', 9], ['minify-disabled-release', 7]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest: multi-line tags, backup rules, permission, network config', () => {
  const dir = project({
    'app/build.gradle': "plugins { id 'com.android.application' }\n",
    'settings.gradle': "include ':app'\n",
    'app/src/main/AndroidManifest.xml': [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      '  <application',
      '    android:allowBackup="true"',
      '    android:dataExtractionRules="@xml/rules">',
      '    <receiver',
      '      android:name=".R"',
      '      android:permission="x.PERM"',
      '      android:exported="true" />',
      '    <!-- <service android:name=".S" android:exported="true" /> -->',
      '    <provider android:name=".P"',
      '      android:exported="true" />',
      '  </application>',
      '</manifest>',
    ].join('\n'),
    'app/src/main/res/xml/network_security_config.xml': '<network-security-config>\n<base-config cleartextTrafficPermitted="true" />\n</network-security-config>\n',
    'app/src/main/res/values/other.xml': '<x cleartextTrafficPermitted="true" />\n',
  });
  try {
    const f = detectStack(dir, catalog).security.findings;
    assert.deepEqual(f.map((x) => [x.id, x.file, x.line]), [
      ['cleartext-traffic', 'app/src/main/res/xml/network_security_config.xml', 2],
      ['exported-component', 'app/src/main/AndroidManifest.xml', 11],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('webview file access signals', () => {
  const dir = project({
    'build.gradle': "plugins { id 'com.android.application' }\n",
    'src/main/java/A.java': 's.setAllowFileAccess(true);\ns.setAllowFileAccess(false);\ns.setAllowUniversalAccessFromFileURLs(true);\n',
  });
  try {
    const f = detectStack(dir, catalog).security.findings.filter((x) => x.id === 'webview-file-access');
    assert.deepEqual(f.map((x) => x.line), [1, 3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rubric names every signal id', () => {
  const rubric = fs.readFileSync(path.join(here, '..', 'skill', 'references', 'rubric-security.md'), 'utf8');
  for (const id of ['cleartext-traffic', 'debuggable-release', 'allow-backup', 'exported-component', 'webview-js-interface', 'webview-file-access', 'hardcoded-secret', 'minify-disabled-release', 'sensitive-log']) {
    assert.ok(rubric.includes(`\`${id}\``), `rubric must name ${id}`);
  }
});

test('findings are capped at 50 per id in the profile, with full counts (100k log lines)', () => {
  // 100 files of 1000 lines (each file stays below the reader's size cap).
  const body = `package a\nfun f() {\n${Array.from({ length: 1000 }, (_, i) => `    Log.d("T", "token ${i}")`).join('\n')}\n}\n`;
  const sources = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`app/src/main/java/a/Noisy${String(i).padStart(3, '0')}.kt`, body]));
  const dir = project({
    ...sources,
    'settings.gradle': "include ':app'\n",
    'app/build.gradle': "plugins { id 'com.android.application' }\n",
    'app/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n  <application android:usesCleartextTraffic="true" />\n</manifest>\n',
  });
  try {
    const started = Date.now();
    const out = execFileSync(process.execPath, ['--import', path.join(here, 'helpers', 'no-network.mjs'), path.join(here, '..', 'skill', 'scripts', 'scan.js'), dir], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    assert.ok(Date.now() - started < 60000, 'scan finishes');
    assert.ok(out.length < 200 * 1024, `scan JSON stays small (${out.length} bytes)`);
    const p = JSON.parse(out);
    const logs = p.security.findings.filter((f) => f.id === 'sensitive-log');
    assert.equal(logs.length, 50);
    assert.deepEqual(logs.map((f) => `${f.file}:${f.line}`), Array.from({ length: 50 }, (_, i) => `app/src/main/java/a/Noisy000.kt:${i + 3}`), 'first 50 in stable order');
    assert.equal(p.security.findings[0].id, 'cleartext-traffic', 'highest severity first');
    assert.deepEqual(p.security.counts, { 'cleartext-traffic': 1, 'sensitive-log': 100000 });
    const md = renderProfileMarkdown(p, catalog);
    assert.match(md, /- sensitive-log: 100000 \(showing first 50\)/);
    assert.match(md, /- cleartext-traffic: 1\n/);
    const arch = renderKnowledge(p, discoverModules(dir, listFiles(dir)), catalog, { date: '2026-11-20', commit: null, catalogVersion: catalog.catalogVersion })['knowledge/architecture-current.md'];
    assert.match(arch, /- high: 1, medium: 0, low: 100000/);
    assert.match(arch, /sensitive-log: 100000 \(showing first 50\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('res/values*/*.xml string resources: secret shapes and credential names are hardcoded-secret, labels are not', () => {
  const googleKey = 'AIza' + 'Sy' + 'X'.repeat(33);
  const named = 'k3y' + 'Value' + '0042';
  const dir = project({
    'settings.gradle': "include ':app'\n",
    'app/build.gradle': "plugins { id 'com.android.application' }\n",
    'app/src/main/res/values/strings.xml': [
      '<resources>',
      `  <string name="google_maps_key" translatable="false">${googleKey}</string>`,
      `  <string name="backend_api_key">${named}</string>`,
      '  <string name="password">Password</string>',
      '  <string name="password_hint">Enter your password</string>',
      '  <string name="token_ref">@string/other</string>',
      '</resources>',
    ].join('\n'),
    'app/src/main/res/values-de/strings.xml': `<resources>\n  <string name="auth_token">${named}</string>\n</resources>\n`,
    'app/src/main/res/layout/main.xml': `<x>${googleKey}</x>\n`,
  });
  try {
    const p = detectStack(dir, catalog);
    const hits = p.security.findings.filter((f) => f.id === 'hardcoded-secret');
    assert.deepEqual(hits.map((f) => [f.file, f.line, f.detail]), [
      ['app/src/main/res/values-de/strings.xml', 2, 'credential'],
      ['app/src/main/res/values/strings.xml', 2, 'google-api-key'],
      ['app/src/main/res/values/strings.xml', 3, 'credential'],
    ]);
    const out = JSON.stringify(p) + renderProfileMarkdown(p, catalog);
    assert.ok(!out.includes(googleKey) && !out.includes(named), 'no secret value in the profile or its Markdown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
