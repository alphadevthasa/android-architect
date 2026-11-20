import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { detectStack } from '../skill/scripts/lib/detect.js';
import { renderProfileMarkdown } from '../skill/scripts/lib/report.js';

const catalog = loadCatalog();

function withProject(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-buildperf-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
    return fn(detectStack(dir, catalog));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const base = { 'settings.gradle.kts': 'include(":app")\n', 'app/build.gradle.kts': 'plugins {\n}\n' };
const item = (p, id) => p.buildPerformance.items.find((i) => i.id === id);

test('gradle.properties keys map to ok, gap with file and line, null line when absent', () => {
  withProject({ ...base, 'gradle.properties': '# c\norg.gradle.jvmargs=-Xmx2g\norg.gradle.caching=true\norg.gradle.parallel = false\n' }, (p) => {
    const caching = item(p, 'org.gradle.caching');
    assert.deepEqual([caching.status, caching.file, caching.line], ['ok', 'gradle.properties', 3]);
    const cc = item(p, 'org.gradle.configuration-cache');
    assert.deepEqual([cc.status, cc.file, cc.line], ['gap', 'gradle.properties', null]);
    const par = item(p, 'org.gradle.parallel');
    assert.deepEqual([par.status, par.file, par.line], ['gap', 'gradle.properties', 4]);
  });
});

test('the legacy unsafe configuration-cache key counts', () => {
  withProject({ ...base, 'gradle.properties': 'org.gradle.unsafe.configuration-cache=true\n' }, (p) => {
    assert.equal(item(p, 'org.gradle.configuration-cache').status, 'ok');
  });
});

test('a missing gradle.properties is unknown, never gap', () => {
  withProject(base, (p) => {
    for (const id of ['org.gradle.configuration-cache', 'org.gradle.caching', 'org.gradle.parallel', 'android.nonTransitiveRClass']) {
      const i = item(p, id);
      assert.equal(i.status, 'unknown', id);
      assert.equal(i.file, null);
      assert.equal(i.line, null);
    }
  });
});

test('nonTransitiveRClass: explicit true ok, explicit false gap, absent unknown', () => {
  withProject({ ...base, 'gradle.properties': 'android.nonTransitiveRClass=true\n' }, (p) => assert.equal(item(p, 'android.nonTransitiveRClass').status, 'ok'));
  withProject({ ...base, 'gradle.properties': 'android.nonTransitiveRClass=false\n' }, (p) => assert.equal(item(p, 'android.nonTransitiveRClass').status, 'gap'));
  withProject({ ...base, 'gradle.properties': 'x=1\n' }, (p) => assert.equal(item(p, 'android.nonTransitiveRClass').status, 'unknown'));
});

test('kapt gives a gap that names KSP; no kapt is ok', () => {
  withProject({ ...base, 'app/build.gradle.kts': 'plugins {\n  id("org.jetbrains.kotlin.kapt")\n}\n', 'gradle.properties': 'x=1\n' }, (p) => {
    const k = item(p, 'kapt');
    assert.equal(k.status, 'gap');
    assert.match(k.detail, /KSP/);
    assert.deepEqual([k.file, k.line], ['app/build.gradle.kts', 2]);
  });
  withProject({ ...base, 'app/build.gradle.kts': 'dependencies {\n  kapt("x:y:1")\n}\n' }, (p) => assert.equal(item(p, 'kapt').status, 'gap'));
  withProject(base, (p) => assert.equal(item(p, 'kapt').status, 'ok'));
});

test('toolchain versions: old Kotlin is a gap against the catalog K2 threshold, AGP and Gradle are unknown', () => {
  withProject({ ...base, 'app/build.gradle.kts': 'plugins {\n  id("org.jetbrains.kotlin.android") version "1.9.0"\n}\n' }, (p) => {
    const k = item(p, 'kotlin-version');
    assert.equal(k.status, 'gap');
    assert.deepEqual([k.file, k.line], ['app/build.gradle.kts', 2]);
    assert.equal(item(p, 'agp-version').status, 'unknown');
    assert.equal(item(p, 'gradle-version').status, 'unknown');
  });
  withProject({ ...base, 'app/build.gradle.kts': 'plugins {\n  id("org.jetbrains.kotlin.android") version "2.0.21"\n}\n' }, (p) => assert.equal(item(p, 'kotlin-version').status, 'ok'));
  withProject(base, (p) => assert.equal(item(p, 'kotlin-version').status, 'unknown'));
});

test('Markdown renders a Build performance section and neutralises hostile text', () => {
  withProject({ ...base, 'gradle.properties': 'org.gradle.caching=true\n' }, (p) => {
    const md = renderProfileMarkdown(p);
    assert.match(md, /## Build performance checks\n/);
    assert.match(md, /org\.gradle\.caching: ok/);
    assert.match(md, /org\.gradle\.configuration-cache: gap/);
  });
});
