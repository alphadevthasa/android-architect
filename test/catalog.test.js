import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, validateCatalog, CatalogError, SUPPORTED_SCHEMA_VERSION } from '../skill/scripts/lib/catalog.js';

const meta = { schemaVersion: 1, catalogVersion: 'x', asOf: '2026-11-19', dimensions: ['d'] };
const entry = (id, extra = {}) => ({
  id, name: id, era: 1, status: 'current', successors: [], detect: { files: ['a'] }, ...extra,
});
const raw = (entries, m = meta, more = []) => ({ meta: m, dimensions: [{ id: 'd', name: 'D', entries }, ...more] });

test('loads shipped catalog', () => {
  const c = loadCatalog();
  assert.equal(c.catalogVersion, '2026.11.0');
  const ids = c.dimensions.map((d) => d.id);
  for (const id of ['language', 'build', 'ui']) assert.ok(ids.includes(id));
  assert.equal(c.entry('language', 'kotlin').id, 'kotlin');
  assert.equal(c.entry('language', 'nope'), undefined);
  assert.equal(SUPPORTED_SCHEMA_VERSION, 1);
});

test('rejects unknown schemaVersion', () => {
  const errs = validateCatalog(raw([entry('a')], { ...meta, schemaVersion: 2 }));
  assert.ok(errs.some((e) => /schemaVersion/.test(e)));
});

test('rejects successor pointing to unknown id', () => {
  const errs = validateCatalog(raw([entry('a', { successors: ['zzz'] })]));
  assert.ok(errs.some((e) => e.includes('unknown successor "zzz"')));
});

test('rejects duplicate entry ids', () => {
  const errs = validateCatalog(raw([entry('a'), entry('a')]));
  assert.ok(errs.some((e) => e.includes('duplicate entry id "a"')));
});

test('rejects entry without detect signals', () => {
  const errs = validateCatalog(raw([entry('a', { detect: {} })]));
  assert.ok(errs.some((e) => e.includes('no detect signals')));
  const errs2 = validateCatalog(raw([entry('a', { detect: { files: [] } })]));
  assert.ok(errs2.some((e) => e.includes('no detect signals')));
});

test('rejects successor cycle', () => {
  const errs = validateCatalog(raw([entry('a', { successors: ['b'] }), entry('b', { successors: ['a'] })]));
  assert.ok(errs.some((e) => e.includes('successor cycle')));
});

test('rejects prerequisite to unknown dimension/entry', () => {
  const e1 = validateCatalog(raw([entry('a', { prerequisites: [{ dimension: 'nope', anyOf: ['x'] }] })]));
  assert.ok(e1.some((e) => e.includes('unknown dimension "nope"')));
  const e2 = validateCatalog(raw([entry('a', { prerequisites: [{ dimension: 'd', anyOf: ['x'] }] })]));
  assert.ok(e2.some((e) => e.includes('unknown entry "x"')));
});

test('rejects bad status', () => {
  const errs = validateCatalog(raw([entry('a', { status: 'old' })]));
  assert.ok(errs.some((e) => e.includes('bad status "old"')));
});

const rawDim = (dimId, entries) => ({ meta, dimensions: [{ id: dimId, name: dimId, entries }] });

test('accepts computed detect and policy on an allowed dimension', () => {
  assert.deepEqual(validateCatalog(rawDim('compliance', [entry('a', { detect: { computed: true }, policy: { x: 1 } })])), []);
});

test('rejects computed detect on a dimension outside the allowlist', () => {
  const errs = validateCatalog(raw([entry('a', { detect: { computed: true } })]));
  assert.ok(errs.some((e) => e.includes('d.a: detect.computed is not allowed')));
});

test('rejects malformed compliance policy', () => {
  const bad = validateCatalog(rawDim('compliance', [entry('a', { detect: { computed: true }, policy: { kind: 'targetSdkMin', value: 'x', effective: 'soon' } })]));
  assert.ok(bad.some((e) => e.includes('policy.value')));
  assert.ok(bad.some((e) => e.includes('policy.effective')));
});

test('loadCatalog throws CatalogError listing errors', () => {
  assert.throws(() => loadCatalog(new URL('./nonexistent-dir/', import.meta.url)), CatalogError);
});

test('every shipped entry validates', () => {
  const c = loadCatalog();
  for (const d of c.dimensions) for (const e of d.entries) {
    assert.ok(Number.isInteger(e.era) && e.era >= 1, `${d.id}.${e.id} era`);
    assert.ok(Array.isArray(e.successors));
  }
});

test('shipped successor and prerequisite rulings', () => {
  const c = loadCatalog();
  assert.deepEqual(c.entry('ui', 'databinding').successors, ['viewbinding', 'compose']);
  assert.deepEqual(c.entry('build', 'kapt').successors, ['ksp']);
  assert.deepEqual(c.entry('language', 'kotlin-k2').detect, { computed: true });
});

test('loads shipped catalog via relative string path', () => {
  assert.equal(loadCatalog('skill/catalog').catalogVersion, '2026.11.0');
});

test('loads catalog from a dir whose name contains #', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat#?%-'));
  fs.cpSync('skill/catalog', tmp, { recursive: true });
  assert.equal(loadCatalog(tmp).catalogVersion, '2026.11.0');
});

test('databinding regex matches common forms', () => {
  const re = new RegExp(loadCatalog().entry('ui', 'databinding').detect.content[0].regex);
  for (const s of ['dataBinding true', 'dataBinding = true', 'dataBinding {', 'dataBinding=true']) assert.ok(re.test(s), s);
  assert.ok(!re.test('dataBinding false'));
});

const EXPECTED_DIMENSIONS = ['language', 'build', 'ui', 'presentation', 'navigation', 'async', 'di', 'networking',
  'serialization', 'persistence', 'keyvalue', 'image', 'background', 'modularization', 'testing', 'static-analysis',
  'compliance', 'build-performance'];

test('catalog has 18 dimensions in declared order', () => {
  const c = loadCatalog();
  assert.equal(c.dimensions.length, 18);
  assert.deepEqual(c.dimensions.map((d) => d.id), EXPECTED_DIMENSIONS);
});

test('presentation successors form the documented chain', () => {
  const c = loadCatalog();
  const succ = (id) => c.entry('presentation', id).successors;
  assert.deepEqual(succ('god-activity'), ['mvp']);
  assert.deepEqual(succ('mvp'), ['mvvm-livedata', 'mvvm-viewmodel']);
  assert.deepEqual(succ('mvvm-viewmodel'), ['udf-stateflow', 'mvvm-clean']);
  assert.equal(c.entry('presentation', 'mvvm-viewmodel').status, 'current');
  assert.deepEqual(c.entry('presentation', 'mvvm-viewmodel').detect, { imports: ['androidx.lifecycle.ViewModel'] });
  assert.deepEqual(succ('mvvm-livedata'), ['mvvm-clean', 'udf-stateflow']);
  assert.deepEqual(succ('mvvm-clean'), ['udf-stateflow']);
  assert.deepEqual(succ('mvi'), ['udf-stateflow']);
  assert.deepEqual(succ('udf-stateflow'), ['circuit-decompose']);
  assert.deepEqual(succ('circuit-decompose'), []);
  for (const id of ['viper', 'ribs', 'square-workflow']) {
    assert.equal(c.entry('presentation', id).status, 'legacy');
    assert.deepEqual(succ(id), []);
  }
  assert.deepEqual([1, 2, 3, 3, 4, 4, 5, 6], ['god-activity', 'mvp', 'mvvm-livedata', 'mvvm-viewmodel', 'mvvm-clean', 'mvi', 'udf-stateflow', 'circuit-decompose'].map((id) => c.entry('presentation', id).era));
});

test('computed detect is accepted only on modularization, compliance, build-performance, language.kotlin-k2, presentation.god-activity, navigation.multi-activity', () => {
  const c = loadCatalog();
  const allowedDims = ['modularization', 'compliance', 'build-performance'];
  const allowedEntries = ['language.kotlin-k2', 'presentation.god-activity', 'navigation.multi-activity'];
  for (const d of c.dimensions) for (const e of d.entries) {
    const key = `${d.id}.${e.id}`;
    if (e.detect.computed) assert.ok(allowedDims.includes(d.id) || allowedEntries.includes(key), `${key} must not be computed`);
  }
  for (const id of allowedDims) assert.ok(c.dimensions.find((d) => d.id === id).entries.some((e) => e.detect.computed), id);
  const errs = validateCatalog(rawDim('presentation', [entry('mvp', { detect: { computed: true } })]));
  assert.ok(errs.some((e) => e.includes('detect.computed is not allowed')));
  assert.deepEqual(validateCatalog(rawDim('presentation', [entry('god-activity', { detect: { computed: true } })])), []);
  assert.deepEqual(validateCatalog(rawDim('language', [entry('kotlin-k2', { detect: { computed: true } })])), []);
  assert.ok(validateCatalog(rawDim('language', [entry('kotlin', { detect: { computed: true } })])).length > 0);
});

test('required entry ids exist per dimension', () => {
  const c = loadCatalog();
  const want = {
    navigation: 'multi-activity fragment-manual cicerone-conductor jetpack-nav-xml nav-compose-string nav-compose-typesafe navigation3 voyager decompose-nav',
    async: 'asynctask-loader eventbus rxjava1 rxjava2 rxjava3 coroutines-livedata coroutines-flow',
    di: 'manual-servicelocator dagger1 dagger2 dagger-android koin kodein hilt kotlin-inject anvil metro',
    networking: 'httpurlconnection apache-httpclient volley okhttp-retrofit ktor-client apollo',
    serialization: 'gson moshi kotlinx-serialization jackson',
    persistence: 'sqliteopenhelper contentprovider ormlite greendao realm room sqldelight sqlcipher',
    keyvalue: 'sharedpreferences encrypted-sharedpreferences datastore mmkv',
    image: 'uil picasso glide fresco coil',
    background: 'service-alarmmanager intentservice jobscheduler firebase-jobdispatcher workmanager',
    modularization: 'single-module layer-modules feature-modules api-impl-modules dynamic-features polyrepo-aar monorepo-convention',
    testing: 'instrumentation-robotium junit4 mockito espresso mockk turbine robolectric compose-ui-test paparazzi roborazzi junit5 kotest',
    'static-analysis': 'android-lint checkstyle pmd findbugs-spotbugs ktlint detekt spotless',
    compliance: 'target-sdk-35 target-sdk-36 page-size-16kb edge-to-edge predictive-back fgs-types',
    'build-performance': 'config-cache build-cache non-transitive-r parallel kapt-free',
  };
  for (const [dim, ids] of Object.entries(want)) {
    assert.deepEqual(c.dimensions.find((d) => d.id === dim).entries.map((e) => e.id).sort(), ids.split(' ').sort(), dim);
  }
  assert.deepEqual(c.entry('compliance', 'target-sdk-35').policy, { kind: 'targetSdkMin', value: 35, effective: '2025-08-31' });
  assert.deepEqual(c.entry('compliance', 'target-sdk-36').policy, { kind: 'targetSdkMin', value: 36, effective: '2026-08-31' });
  assert.deepEqual(c.entry('navigation', 'nav-compose-typesafe').detect.gradle, [{ coord: 'androidx.navigation:navigation-compose', minVersion: '2.8' }]);
  assert.deepEqual(c.entry('keyvalue', 'datastore').prerequisites, [{ dimension: 'async', anyOf: ['coroutines-livedata', 'coroutines-flow'] }]);
  assert.deepEqual(c.entry('async', 'coroutines-flow').prerequisites, [{ dimension: 'language', anyOf: ['kotlin', 'kotlin-k2', 'kmp'] }]);
});

test('shipped regexes and globs are well formed', () => {
  const c = loadCatalog();
  for (const d of c.dimensions) for (const e of d.entries) for (const item of e.detect.content ?? []) {
    assert.doesNotThrow(() => new RegExp(item.regex), `${d.id}.${e.id}`);
  }
  const re = new RegExp(c.entry('build-performance', 'config-cache').detect.content[0].regex);
  assert.ok(re.test('org.gradle.configuration-cache=true'));
  assert.ok(!re.test('org.gradle.configuration-cache=false'));
  assert.ok(new RegExp(c.entry('presentation', 'udf-stateflow').detect.content[0].regex).test('MutableStateFlow<HomeUiState>(HomeUiState())'));
  const lint = new RegExp(c.entry('static-analysis', 'android-lint').detect.content[0].regex);
  for (const t of ['lint {', '    lintOptions {', 'android.lint {']) assert.ok(lint.test(t), t);
  for (const t of ['ktlint {', 'detektlint {']) assert.ok(!lint.test(t), t);
  assert.equal(c.entry('static-analysis', 'ktlint').detect.files, undefined);
});

test('multi-activity is computed and documents the manifest rule', () => {
  const e = loadCatalog().entry('navigation', 'multi-activity');
  assert.deepEqual(e.detect, { computed: true });
  assert.match(e.notes, /AndroidManifest\.xml/);
  assert.deepEqual(validateCatalog(rawDim('navigation', [entry('multi-activity', { detect: { computed: true } })])), []);
});

test('roborazzi import prefix is the real package', () => {
  assert.deepEqual(loadCatalog().entry('testing', 'roborazzi').detect.imports, ['io.github.takahirom.roborazzi']);
});

test('gradle.properties regexes are line-anchored and whitespace tolerant', () => {
  const c = loadCatalog();
  const keys = { 'config-cache': 'org.gradle.configuration-cache', 'build-cache': 'org.gradle.caching',
    'non-transitive-r': 'android.nonTransitiveRClass', parallel: 'org.gradle.parallel' };
  for (const [id, key] of Object.entries(keys)) {
    const re = new RegExp(c.entry('build-performance', id).detect.content[0].regex);
    assert.ok(!re.test(`# ${key}=true`), `${id} commented`);
    assert.ok(!re.test(`#${key}=true`), `${id} commented tight`);
    assert.ok(re.test(`${key}=true`), `${id} tight`);
    assert.ok(re.test(`${key} = true`), `${id} spaced`);
    assert.ok(!re.test(`${key}=false`), `${id} false`);
  }
});
