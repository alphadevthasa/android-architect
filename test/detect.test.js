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
  assert.ok(p.compliance.some((c) => c.id === 'target-sdk-36' && c.status === 'gap'));
});

test('modern-compose profile', () => {
  const p = scan('modern-compose');
  assert.deepEqual(p.dimensions.language.entries.map(({ id, share }) => ({ id, share })), [
    { id: 'kotlin', share: 1 },
    { id: 'kotlin-k2', share: null },
  ]);
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
  assert.equal(p.compliance.find((c) => c.id === 'target-sdk-36').status, 'gap');
  assert.deepEqual(p.modules.map((m) => m.path), [':app', ':core:data', ':feature:home']);
});

test('supersede: navigation-compose 2.8+ is type-safe only', () => {
  const p = scan('modern-compose');
  assert.deepEqual(p.dimensions.navigation.entries.map(({ id, share }) => ({ id, share })), [{ id: 'nav-compose-typesafe', share: 1 }]);
});

test('supersede: navigation-compose 2.7.0 stays string routes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-detect-'));
  try {
    fs.writeFileSync(path.join(tmp, 'settings.gradle'), "include ':app'\n");
    fs.mkdirSync(path.join(tmp, 'app'));
    fs.writeFileSync(
      path.join(tmp, 'app/build.gradle'),
      "dependencies {\n    implementation 'androidx.navigation:navigation-compose:2.7.0'\n}\n",
    );
    const p = detectStack(tmp, catalog);
    assert.deepEqual(
      p.dimensions.navigation.entries.map(({ id, share, evidence }) => ({ id, share, evidence })),
      [{ id: 'nav-compose-string', share: 1, evidence: [{ file: 'app/build.gradle', line: 2, signal: 'gradle androidx.navigation:navigation-compose' }] }],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const withProject = (files, fn) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-detect-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), text);
    }
    return fn(detectStack(tmp, catalog));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

test('computed entries are presence flags: many .kt files do not dilute kotlin-k2', () => {
  const files = {
    'settings.gradle.kts': 'include(":app")\n',
    'app/build.gradle.kts': 'plugins {\n    id("org.jetbrains.kotlin.android") version "2.0.21"\n}\n',
  };
  for (let i = 0; i < 200; i++) files[`app/src/main/kotlin/F${i}.kt`] = `class F${i}\n`;
  withProject(files, (p) => {
    const lang = p.dimensions.language.entries;
    assert.deepEqual(lang.map(({ id, share }) => ({ id, share })), [
      { id: 'kotlin', share: 1 },
      { id: 'kotlin-k2', share: null },
    ]);
    assert.equal(lang[1].units, 1);
    assert.deepEqual(lang[1].evidence, [{ file: 'app/build.gradle.kts', line: 2, signal: 'kotlin plugin 2.0.21' }]);
    assert.match(renderProfileMarkdown(p), /^- Kotlin K2 compiler \(Kotlin 2\.x\): present \(evidence: app\/build\.gradle\.kts:2\)$/m);
  });
});

test('supersede is per module: other evidence keeps X only in its own module', () => {
  const nav = "dependencies {\n    implementation 'androidx.navigation:navigation-compose:2.8.0'\n}\n";
  withProject(
    {
      'settings.gradle': "include ':a', ':b'\n",
      'a/build.gradle': nav,
      'b/build.gradle': nav,
      'a/src/main/kotlin/Nav.kt': 'fun g() {\n    composable("home") {}\n}\n',
    },
    (p) => {
      const navEntries = p.dimensions.navigation.entries;
      const str = navEntries.find((e) => e.id === 'nav-compose-string');
      const typed = navEntries.find((e) => e.id === 'nav-compose-typesafe');
      assert.ok(str, 'string routes kept for module a');
      assert.ok(str.evidence.every((e) => e.file.startsWith('a/')), JSON.stringify(str.evidence));
      assert.deepEqual(str.evidence.map((e) => `${e.file}:${e.line}`), ['a/build.gradle:2', 'a/src/main/kotlin/Nav.kt:2']);
      assert.equal(typed.units, 2);
    },
  );
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
      const shared = entries.filter((e) => e.share !== null);
      const flags = entries.filter((e) => e.share === null);
      assert.deepEqual(entries, [...shared, ...flags], `${n}/${dim} share entries before presence entries`);
      if (shared.length) {
        const sum = shared.reduce((s, e) => s + e.share, 0);
        assert.ok(Math.abs(sum - 1) < 0.05, `${n}/${dim} shares sum ${sum}`);
      }
      for (let i = 1; i < shared.length; i++) {
        const a = shared[i - 1];
        const b = shared[i];
        assert.ok(a.share > b.share || (a.share === b.share && a.id < b.id), `${n}/${dim} order`);
      }
      for (let i = 1; i < flags.length; i++) assert.ok(flags[i - 1].id < flags[i].id, `${n}/${dim} flag order`);
      for (const e of flags) assert.ok(catalog.entry(dim, e.id).detect.computed, `${n}/${dim}/${e.id} null share only for computed`);
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

test('I1: a dimension minority that rounds to 0% is still present and renders as <1%', async () => {
  const { presentIds, candidatePaths } = await import('../skill/scripts/lib/candidates.js');
  const files = { 'settings.gradle': "include ':app'\n", 'app/build.gradle': '' };
  for (let i = 0; i < 250; i++) files[`app/src/main/res/layout/l${i}.xml`] = '<LinearLayout/>\n';
  files['app/src/main/java/Screen.kt'] = 'import androidx.compose.runtime.Composable\n';
  withProject(files, (p) => {
    const compose = p.dimensions.ui.entries.find((e) => e.id === 'compose');
    assert.equal(compose.share, 0);
    assert.equal(compose.units, 1);
    assert.ok(presentIds(p, 'ui').has('compose'));
    assert.ok(candidatePaths(p, catalog).ui.current.includes('compose'));
    assert.match(renderProfileMarkdown(p), /^- Jetpack Compose: <1% /m);
  });
});

test('I4: udf-stateflow matches StateFlow<UiState> and MutableStateFlow(UiState(...))', () => {
  const files = {
    'settings.gradle': "include ':app'\n",
    'app/build.gradle': '',
    'app/src/main/java/A.kt': 'class A {\n  val state: StateFlow<HomeUiState> = s\n}\n',
    'app/src/main/java/B.kt': 'class B {\n  private val s = MutableStateFlow(\n    DetailUiState())\n  val t = MutableStateFlow( DetailUiState())\n}\n',
  };
  withProject(files, (p) => {
    const udf = p.dimensions.presentation.entries.find((e) => e.id === 'udf-stateflow');
    assert.ok(udf, JSON.stringify(p.dimensions.presentation));
    assert.equal(udf.units, 2);
  });
});

test('I4: plain Jetpack ViewModel is mvvm-viewmodel, not mvvm-livedata', () => {
  const vm = 'import androidx.lifecycle.ViewModel\nclass HomeViewModel : ViewModel()\n';
  withProject({ 'settings.gradle': "include ':app'\n", 'app/build.gradle': '', 'app/src/main/java/HomeViewModel.kt': vm }, (p) => {
    assert.deepEqual(ids(p, 'presentation'), ['mvvm-viewmodel']);
  });
  // A ViewModel file that already uses LiveData counts as mvvm-livedata only.
  const lv = 'import androidx.lifecycle.LiveData\nimport androidx.lifecycle.ViewModel\nclass V : ViewModel()\n';
  withProject({ 'settings.gradle': "include ':app'\n", 'app/build.gradle': '', 'app/src/main/java/V.kt': lv }, (p) => {
    assert.deepEqual(ids(p, 'presentation'), ['mvvm-livedata']);
  });
});

test('I5: feature module names and top-level-only layer modules', () => {
  const settings = "include ':app', ':features:login', ':feature-home', ':feature_cart', ':core:data', ':data', ':featureflags'\n";
  withProject({ 'settings.gradle': settings }, (p) => {
    const ev = (id) => p.dimensions.modularization.entries.find((e) => e.id === id);
    assert.deepEqual(ev('feature-modules').units, 3);
    assert.deepEqual(ev('layer-modules').units, 1);
    assert.ok(ev('layer-modules').evidence.every((e) => /computed layer module :data$/.test(e.signal)));
  });
  assert.deepEqual(ids(scan('modern-compose'), 'modularization'), ['feature-modules']);
});

test('I6: compliance uses the highest targetSdkMin policy effective by catalog asOf', () => {
  const legacy = scan('legacy-java-mvp').compliance;
  assert.deepEqual(legacy.map((c) => [c.id, c.status]), [['target-sdk-36', 'gap']]);
  assert.match(legacy[0].detail, /max targetSdk is 28/);
  assert.match(legacy[0].detail, /36/);
  assert.deepEqual(scan('modern-compose').compliance.map((c) => [c.id, c.status]), [['target-sdk-36', 'gap']]);
  const older = { ...catalog, asOf: '2026-01-01' };
  const p = detectStack(fx('modern-compose'), older);
  assert.deepEqual(p.compliance.map((c) => [c.id, c.status]), [['target-sdk-35', 'ok']]);
  assert.doesNotMatch(renderProfileMarkdown(scan('modern-compose')), /requires 35/);
});

test('M2: ktlint needs ktlint_ keys in .editorconfig; android-lint ignores ktlint {', () => {
  withProject({
    'settings.gradle': "include ':app'\n",
    'app/build.gradle': 'ktlint {\n  android = true\n}\n',
    '.editorconfig': 'root = true\n[*]\nindent_size = 4\n',
  }, (p) => {
    assert.ok(!ids(p, 'static-analysis').includes('android-lint'));
    assert.ok(!ids(p, 'static-analysis').includes('ktlint'));
  });
  withProject({
    'settings.gradle': "include ':app'\n",
    'app/build.gradle': 'android {\n  lint {\n    abortOnError false\n  }\n}\n',
    '.editorconfig': '[*.{kt,kts}]\nktlint_standard_no-wildcard-imports = disabled\n',
  }, (p) => {
    assert.ok(ids(p, 'static-analysis').includes('android-lint'));
    assert.ok(ids(p, 'static-analysis').includes('ktlint'));
  });
});

test('M3: multi-activity ignores <activity-alias>', () => {
  const manifest = (n, aliases) => '<manifest>\n<application>\n'
    + Array.from({ length: n }, (_, i) => `<activity android:name=".A${i}"/>\n`).join('')
    + Array.from({ length: aliases }, (_, i) => `<activity-alias android:name=".L${i}"/>\n`).join('')
    + '</application>\n</manifest>\n';
  const base = { 'settings.gradle': "include ':app'\n", 'app/build.gradle': '' };
  withProject({ ...base, 'app/src/main/AndroidManifest.xml': manifest(2, 3) }, (p) => {
    assert.ok(!ids(p, 'navigation').includes('multi-activity'));
  });
  withProject({ ...base, 'app/src/main/AndroidManifest.xml': manifest(3, 1) }, (p) => {
    const e = p.dimensions.navigation.entries.find((x) => x.id === 'multi-activity');
    assert.equal(e.evidence.length, 3);
  });
});

test('I2: unresolvable targetSdk yields an unknown compliance row', () => {
  withProject({
    'settings.gradle': "include ':app'\n",
    'app/build.gradle': 'android {\n  defaultConfig {\n    targetSdkVersion computeTarget()\n  }\n}\n',
  }, (p) => {
    assert.equal(p.sdk.targetSdk, null);
    assert.deepEqual(p.compliance, [{ id: 'target-sdk-36', status: 'unknown', detail: 'targetSdk not statically resolvable' }]);
    assert.match(renderProfileMarkdown(p), /: unknown \(targetSdk not statically resolvable\)/);
  });
});

test('I2: targetSdk from root ext and from libs.versions reaches the profile', () => {
  withProject({
    'settings.gradle': "include ':app'\n",
    'build.gradle': 'ext {\n  targetSdkVersion = 36\n}\n',
    'app/build.gradle': 'android {\n  defaultConfig {\n    targetSdkVersion rootProject.ext.targetSdkVersion\n  }\n}\n',
  }, (p) => assert.deepEqual(p.compliance.map((c) => [c.id, c.status]), [['target-sdk-36', 'ok']]));
  withProject({
    'settings.gradle.kts': 'include(":app")\n',
    'gradle/libs.versions.toml': '[versions]\ntargetSdk = "34"\n',
    'app/build.gradle.kts': 'android {\n  defaultConfig {\n    targetSdk = libs.versions.targetSdk.get().toInt()\n  }\n}\n',
  }, (p) => assert.equal(p.sdk.targetSdk, 34));
});

test('M4: imports match on a segment boundary', () => {
  const base = { 'settings.gradle': "include ':app'\n", 'app/build.gradle': '' };
  const src = (imp) => ({ ...base, 'app/src/main/java/A.kt': `import ${imp}\nclass A\n` });
  withProject(src('androidx.lifecycle.ViewModelProvider'), (p) => {
    assert.ok(!ids(p, 'presentation').includes('mvvm-viewmodel'));
  });
  withProject(src('androidx.lifecycle.ViewModel'), (p) => {
    assert.ok(ids(p, 'presentation').includes('mvvm-viewmodel'));
  });
  // A package prefix still matches its sub-packages and classes.
  withProject(src('org.koin.core.context.startKoin'), (p) => {
    assert.ok(ids(p, 'di').includes('koin'));
  });
  withProject(src('androidx.compose.material3.Text'), (p) => {
    assert.ok(ids(p, 'ui').includes('compose'));
  });
  withProject(src('org.koinfoo.Bar'), (p) => {
    assert.ok(!ids(p, 'di').includes('koin'));
  });
});

test('M5: app-plus-libraries is detected for one application plus library modules', () => {
  const entries = (p) => p.dimensions.modularization.entries;
  const app = "plugins { id 'com.android.application' }\n";
  const lib = "plugins { id 'com.android.library' }\n";
  withProject({ 'settings.gradle': "include ':app', ':library'\n", 'app/build.gradle': app, 'library/build.gradle': lib }, (p) => {
    assert.deepEqual(ids(p, 'modularization'), ['app-plus-libraries']);
    assert.equal(entries(p)[0].share, null);
  });
  withProject({ 'settings.gradle': "include ':app', ':util'\n", 'app/build.gradle': app, 'util/build.gradle': "plugins { id 'java-library' }\n" }, (p) => {
    has(p, 'modularization', 'app-plus-libraries');
  });
  withProject({ 'settings.gradle': "include ':app', ':util'\n", 'app/build.gradle': app, 'util/build.gradle': "plugins { id 'org.jetbrains.kotlin.jvm' }\n" }, (p) => {
    has(p, 'modularization', 'app-plus-libraries');
  });
  // Feature-module naming means feature-modules, not app-plus-libraries.
  withProject({ 'settings.gradle': "include ':app', ':feature-home'\n", 'app/build.gradle': app, 'feature-home/build.gradle': lib }, (p) => {
    assert.deepEqual(ids(p, 'modularization'), ['feature-modules']);
  });
  // Two applications, or no library, is not this layout.
  withProject({ 'settings.gradle': "include ':app', ':other'\n", 'app/build.gradle': app, 'other/build.gradle': app }, (p) => {
    assert.ok(!ids(p, 'modularization').includes('app-plus-libraries'));
  });
  withProject({ 'settings.gradle': "include ':app'\n", 'app/build.gradle': app }, (p) => {
    assert.deepEqual(ids(p, 'modularization'), ['single-module']);
  });
});
