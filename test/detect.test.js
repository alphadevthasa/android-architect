import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { detectStack } from '../skill/scripts/lib/detect.js';
import { globToRegExp } from '../skill/scripts/lib/glob.js';
import { renderProfileMarkdown } from '../skill/scripts/lib/report.js';

const fx = (n) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n);
const catalog = loadCatalog();
const cache = new Map();
const scan = (n) => {
  if (!cache.has(n)) cache.set(n, detectStack(fx(n), catalog));
  return cache.get(n);
};
const ids = (p, dim) => p.dimensions[dim].entries.map((e) => e.id);
const has = (p, dim, ...want) => {
  const got = ids(p, dim);
  for (const w of want) assert.ok(got.includes(w), `${dim} should contain ${w}, got ${JSON.stringify(got)}`);
};

test('globToRegExp supports **/, *, {a,b}', () => {
  assert.ok(globToRegExp('**/*.java').test('A.java'));
  assert.ok(globToRegExp('**/*.java').test('a/b/A.java'));
  assert.ok(!globToRegExp('**/*.java').test('a/b/A.kt'));
  assert.ok(globToRegExp('**/*.{java,kt}').test('x/A.kt'));
  assert.ok(globToRegExp('**/res/layout*/*.xml').test('app/src/main/res/layout-land/a.xml'));
  assert.ok(!globToRegExp('**/res/layout*/*.xml').test('app/src/main/res/layout/sub/a.xml'));
  assert.ok(globToRegExp('buildSrc/**').test('buildSrc/src/main/kotlin/X.kt'));
  assert.ok(!globToRegExp('build.xml').test('app/build.xml'));
  assert.ok(globToRegExp('**/build.gradle*').test('app/build.gradle.kts'));
  assert.ok(!globToRegExp('*.kt').test('a/B.kt'));
});

test('legacy-java-mvp profile', () => {
  const p = scan('legacy-java-mvp');
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.root, '.');
  assert.deepEqual(p.dimensions.language.entries.map(({ id, share }) => ({ id, share })), [{ id: 'java', share: 1 }]);
  has(p, 'presentation', 'mvp');
  has(p, 'ui', 'butterknife', 'xml-findviewbyid', 'xml-layouts');
  has(p, 'async', 'rxjava2', 'asynctask-loader');
  has(p, 'di', 'dagger2');
  has(p, 'persistence', 'sqliteopenhelper');
  has(p, 'networking', 'okhttp-retrofit');
  has(p, 'serialization', 'gson');
  assert.deepEqual(ids(p, 'modularization'), ['single-module']);
  assert.equal(p.sdk.targetSdk, 28);
  assert.equal(p.sdk.minSdk, 19);
  assert.ok(p.compliance.some((c) => c.id === 'target-sdk-35' && c.status === 'gap'));
});

test('modern-compose profile', () => {
  const p = scan('modern-compose');
  has(p, 'language', 'kotlin-k2');
  has(p, 'build', 'gradle-kts', 'version-catalog', 'convention-plugins', 'ksp');
  has(p, 'presentation', 'udf-stateflow', 'mvvm-clean');
  has(p, 'ui', 'compose');
  has(p, 'di', 'hilt');
  has(p, 'persistence', 'room');
  has(p, 'navigation', 'nav-compose-typesafe');
  has(p, 'testing', 'mockk', 'turbine');
  has(p, 'modularization', 'feature-modules');
  has(p, 'build-performance', 'config-cache', 'kapt-free');
  assert.ok(!ids(p, 'build').includes('kapt'));
  assert.equal(p.compliance.find((c) => c.id === 'target-sdk-35').status, 'ok');
  assert.deepEqual(p.modules.map((m) => m.path), [':app', ':core:data', ':feature:home']);
});

test('mixed profile: ui shares and coexisting patterns', () => {
  const p = scan('mixed');
  assert.deepEqual(
    p.dimensions.ui.entries.map(({ id, share }) => ({ id, share })),
    [{ id: 'xml-layouts', share: 0.6 }, { id: 'compose', share: 0.4 }],
  );
  has(p, 'presentation', 'mvvm-livedata', 'udf-stateflow');
  has(p, 'keyvalue', 'sharedpreferences', 'datastore');
});

test('entries are sorted, shares sum to ~1, evidence capped and sorted', () => {
  for (const n of ['legacy-java-mvp', 'modern-compose', 'mixed']) {
    const p = scan(n);
    for (const [dim, { entries }] of Object.entries(p.dimensions)) {
      if (entries.length === 0) continue;
      const sum = entries.reduce((s, e) => s + e.share, 0);
      assert.ok(Math.abs(sum - 1) < 0.05, `${n}/${dim} shares sum ${sum}`);
      for (let i = 1; i < entries.length; i++) {
        const a = entries[i - 1];
        const b = entries[i];
        assert.ok(a.share > b.share || (a.share === b.share && a.id < b.id), `${n}/${dim} order`);
      }
      for (const e of entries) {
        assert.ok(e.units > 0);
        assert.ok(e.evidence.length <= 5);
        for (let i = 1; i < e.evidence.length; i++) {
          const x = e.evidence[i - 1];
          const y = e.evidence[i];
          assert.ok(x.file < y.file || (x.file === y.file && (x.line ?? 0) <= (y.line ?? 0)));
        }
      }
    }
  }
});

test('evidence line numbers are 1-based and survive CRLF', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-detect-'));
  try {
    fs.copyFileSync(path.join(fx('mixed'), 'settings.gradle'), path.join(tmp, 'settings.gradle'));
    const src = fs.readFileSync(path.join(fx('mixed'), 'app/src/main/java/com/example/mixed/AppModule.kt'), 'utf8');
    const dir = path.join(tmp, 'app/src/main/java');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AppModule.kt'), '﻿' + src.replace(/\n/g, '\r\n'));
    const p = detectStack(tmp, catalog);
    const koin = p.dimensions.di.entries.find((e) => e.id === 'koin');
    assert.ok(koin, 'koin detected');
    assert.deepEqual(koin.evidence[0], { file: 'app/src/main/java/AppModule.kt', line: 3, signal: 'import org.koin' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderProfileMarkdown lists entries with percentages and evidence', () => {
  const md = renderProfileMarkdown(scan('mixed'));
  assert.match(md, /^## UI toolkit$/m);
  assert.match(md, /^- XML layouts: 60% \(evidence: app\/src\/main\/res\/layout\/activity_main\.xml/m);
  assert.match(md, /^- Jetpack Compose: 40% \(evidence: app\/src\/main\/java\/com\/example\/mixed\/ProfileScreen\.kt:3/m);
});
