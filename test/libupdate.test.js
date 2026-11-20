import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCatalog, loadVersions } from '../skill/scripts/lib/catalog.js';
import { collectBuildUnits } from '../skill/scripts/lib/detect.js';
import { planLibraryUpdates, renderLibraryUpdates } from '../skill/scripts/lib/libupdate.js';
import { scanInstructions } from '../skill/scripts/lib/injection.js';
import { expectedToolHashes } from '../skill/scripts/lib/integrity.js';

const SKILL = path.resolve('skill');
const CATALOG_DIR = path.join(SKILL, 'catalog');
const CLI = path.join(SKILL, 'scripts/lib-update.js');
const HELPER = path.resolve('test/helpers/no-network.mjs');
const catalog = loadCatalog();

const VERSIONS = {
  schemaVersion: 1,
  asOf: '2026-11-01',
  libraries: [
    { coord: 'com.google.code.gson:gson', stable: '2.11.0', group: 'json' },
    { coord: 'com.squareup.okhttp3:okhttp', stable: '4.12.0', group: 'networking' },
    { coord: 'com.squareup.retrofit2:retrofit', stable: '3.0.0', group: 'networking', requires: { kotlin: '>=1.9' } },
    { coord: 'androidx.core:core-ktx', stable: '1.15.0', group: 'androidx-core' },
    { coord: 'org.jetbrains.kotlinx:kotlinx-coroutines-core', stable: '1.9.0', group: 'kotlinx' },
  ],
};

const FILES = {
  'settings.gradle.kts': 'include(":app", ":feature:home")\n',
  'gradle/libs.versions.toml': [
    '[versions]', 'retrofit = "2.9.0"', '[libraries]',
    'retrofit = { group = "com.squareup.retrofit2", name = "retrofit", version.ref = "retrofit" }', '',
  ].join('\n'),
  'app/build.gradle.kts': [
    'dependencies {',
    '  implementation("com.google.code.gson:gson:2.8.6")',
    '  implementation("com.squareup.okhttp3:okhttp:4.9.0")',
    '  implementation("androidx.core:core-ktx:1.15.0")',
    '  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.0")',
    '  implementation("com.foo:dyn:2.+")',
    '  implementation("com.foo:latest:latest.release")',
    '  implementation(libs.retrofit)',
    '  implementation(libs.nothere)',
    '  implementation("com.unknown:lib:1.0.0")',
    '  implementation(project(":feature:home"))',
    '  // val apiKey = "AKIAIOSFODNN7EXAMPLE"',
    '}',
    '',
  ].join('\n'),
  'feature/home/build.gradle.kts': 'dependencies {\n  implementation("androidx.core:core-ktx:1.12.0")\n}\n',
};

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-libupdate-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function project(files = FILES) {
  const root = path.join(tmp, 'proj');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function plan(root, versions = VERSIONS, opts = {}) {
  const { units, modules } = collectBuildUnits(root);
  return planLibraryUpdates({ catalogVersion: catalog.catalogVersion }, modules, catalog, versions, { today: '2026-11-10', units, ...opts });
}
const items = (p) => p.groups.flatMap((g) => g.items);
const find = (p, coord, module) => items(p).find((i) => i.coord === coord && (module === undefined || i.module === module));

test('a vulnerable Gson is the only security item and comes first', () => {
  const p = plan(project());
  assert.equal(p.groups[0].id, 'security');
  assert.deepEqual(p.groups[0].items.map((i) => i.coord), ['com.google.code.gson:gson']);
  const g = p.groups[0].items[0];
  assert.equal(g.reason, 'security');
  assert.equal(g.advisory.id, 'CVE-2022-25647');
  assert.equal(g.current, '2.8.6');
  assert.equal(g.target, '2.11.0');
  assert.equal(g.file, 'app/build.gradle.kts');
  assert.equal(g.line, 2);
  assert.equal(items(p).filter((i) => i.coord === g.coord).length, 1);
});

test('routine updates group by update group, majors come last with their requires', () => {
  const p = plan(project());
  const ids = p.groups.map((g) => g.id);
  assert.deepEqual(ids, ['security', 'androidx-core', 'networking', 'major']);
  const major = p.groups.at(-1);
  assert.deepEqual(major.items.map((i) => i.coord), ['com.squareup.retrofit2:retrofit']);
  assert.equal(major.items[0].kind, 'major');
  assert.deepEqual(major.items[0].requires, { kotlin: '>=1.9' });
  assert.equal(major.items[0].current, '2.9.0');
  assert.equal(major.items[0].target, '3.0.0');
  assert.ok(major.prerequisites.some((x) => x.requirement === 'kotlin >=1.9' && x.coords.includes('com.squareup.retrofit2:retrofit')));
  const net = p.groups.find((g) => g.id === 'networking');
  assert.deepEqual(net.items.map((i) => [i.coord, i.kind, i.target]), [['com.squareup.okhttp3:okhttp', 'minor', '4.12.0']]);
});

test('up-to-date and newer-than-data dependencies produce no item', () => {
  const p = plan(project());
  assert.equal(find(p, 'org.jetbrains.kotlinx:kotlinx-coroutines-core'), undefined);
  assert.equal(items(p).filter((i) => i.coord === 'androidx.core:core-ktx').length, 1);
  assert.equal(find(p, 'androidx.core:core-ktx').module, ':feature:home');
  assert.ok(!p.cannotUpdate.some((c) => c.coord === 'org.jetbrains.kotlinx:kotlinx-coroutines-core'));
});

test('dynamic, unresolved and unknown dependencies are cannotUpdate and never get a target', () => {
  const p = plan(project());
  const by = (re) => p.cannotUpdate.find((c) => re.test(c.coord ?? c.alias ?? ''));
  for (const re of [/com\.foo:dyn/, /com\.foo:latest/, /nothere/, /com\.unknown:lib/]) {
    const c = by(re);
    assert.ok(c, String(re));
    assert.ok(c.reason.length > 0);
    assert.ok(!('target' in c));
  }
  assert.match(by(/dyn/).reason, /dynamic/);
  assert.match(by(/nothere/).reason, /alias/);
  assert.match(by(/com\.unknown/).reason, /versions\.json/);
  assert.equal(find(p, 'com.foo:dyn'), undefined);
});

test('stale data marks every item verify; fresh data does not for routine patch updates', () => {
  const stale = plan(project(), VERSIONS, { today: '2027-02-09' });
  assert.equal(stale.stale, true);
  assert.ok(items(stale).length > 0 && items(stale).every((i) => i.verify === true));
  const fresh = plan(project(), VERSIONS, { today: '2026-11-11' });
  assert.equal(fresh.stale, false);
  assert.equal(find(fresh, 'com.squareup.okhttp3:okhttp').verify, false);
  assert.equal(find(fresh, 'androidx.core:core-ktx').verify, false);
  assert.equal(find(fresh, 'com.google.code.gson:gson').verify, false);
  // a major jump for a coord with no advisory data needs verification
  assert.equal(find(fresh, 'com.squareup.retrofit2:retrofit').verify, true);
});

test('a security item with no fixed version in the data has a null target and a note', () => {
  const none = { ...VERSIONS, libraries: VERSIONS.libraries.filter((l) => !l.coord.includes('gson')) };
  const p = plan(project(), none);
  const g = p.groups[0].items[0];
  assert.equal(g.target, null);
  assert.match(g.note, /no fixed version known: check the advisory source/);
  // a stable version that is itself vulnerable is not a fix
  const bad = { ...VERSIONS, libraries: VERSIONS.libraries.map((l) => (l.coord.includes('gson') ? { ...l, stable: '2.8.8' } : l)) };
  assert.equal(plan(project(), bad).groups[0].items[0].target, null);
});

test('security items sort by severity, then coord', () => {
  const adv = (id, severity) => ({ coord: 'a.b:c', range: '<9', id, severity, summary: 's', source: 'https://example.invalid/x' });
  const cat = { catalogVersion: 'x', dimensions: [{ id: 'd', entries: [{
    id: 'e', vulnerableVersions: [adv('X-1', 'low'), { ...adv('X-2', 'critical'), coord: 'a.b:d' }],
  }] }] };
  const root = project({ 'build.gradle': "dependencies {\n  implementation 'a.b:c:1.0'\n  implementation 'a.b:d:1.0'\n}\n" });
  const { units, modules } = collectBuildUnits(root);
  const p = planLibraryUpdates({}, modules, cat, VERSIONS, { today: '2026-11-10', units });
  assert.deepEqual(p.groups[0].items.map((i) => i.advisory.id), ['X-2', 'X-1']);
});

test('version catalog aliases resolve and items cite file and line', () => {
  const r = find(plan(project()), 'com.squareup.retrofit2:retrofit');
  assert.equal(r.file, 'app/build.gradle.kts');
  assert.equal(r.line, 8);
  assert.equal(r.module, ':app');
});

test('scope limits items to one module', () => {
  const p = plan(project(), VERSIONS, { scope: ':feature:home' });
  assert.deepEqual(items(p).map((i) => i.module), [':feature:home']);
  assert.ok(p.cannotUpdate.every((c) => c.module === ':feature:home'));
});

test('identical declarations are deduplicated', () => {
  const root = project({ 'build.gradle': "dependencies {\n  implementation 'androidx.core:core-ktx:1.0.0'\n}\n" });
  const { units, modules } = collectBuildUnits(root);
  const p = planLibraryUpdates({}, modules, catalog, VERSIONS, { today: '2026-11-10', units: [...units, ...units] });
  assert.equal(items(p).length, 1);
});

test('Markdown is sanitized, capped per group and carries no secret', () => {
  const lines = ['dependencies {'];
  for (let i = 0; i < 305; i++) lines.push(`  implementation("androidx.core:core-ktx:1.${i % 3}.${i}")`);
  lines.push('  implementation("x.y:z|# evil‮:1.0")', '}');
  const root = project({ 'build.gradle.kts': lines.join('\n') + '\n' });
  const md = renderLibraryUpdates(plan(root));
  assert.match(md, /and \d+ more/);
  assert.ok(md.split('\n').filter((l) => l.startsWith('| ')).length < 320);
  assert.ok(!md.includes('‮'));
  assert.ok(!/^# evil/m.test(md));
  const full = JSON.stringify(plan(project()));
  assert.ok(!full.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('loadVersions rejects malformed data with file-prefixed errors', () => {
  const put = (data) => { fs.writeFileSync(path.join(tmp, 'versions.json'), typeof data === 'string' ? data : JSON.stringify(data)); return tmp; };
  const lib = VERSIONS.libraries[0];
  const bad = (data, re) => assert.throws(() => loadVersions(put(data)), (e) => re.test(e.message) && e.message.split('\n').every((l) => l.startsWith('versions.json:')), String(re));
  assert.deepEqual(loadVersions(put(VERSIONS)).libraries.length, 5);
  bad('{not json', /cannot read or parse/);
  bad({ ...VERSIONS, asOf: undefined }, /asOf/);
  bad({ ...VERSIONS, asOf: '2026-13-40' }, /asOf/);
  bad({ ...VERSIONS, schemaVersion: 2 }, /schemaVersion/);
  bad({ ...VERSIONS, libraries: [{ ...lib, coord: 'nocolon' }] }, /coord/);
  bad({ ...VERSIONS, libraries: [{ ...lib, stable: 3 }] }, /stable/);
  bad({ ...VERSIONS, libraries: [{ ...lib, stable: 'x.y' }] }, /stable/);
  bad({ ...VERSIONS, libraries: [{ ...lib, group: 'Bad Group' }] }, /group/);
  bad({ ...VERSIONS, libraries: [{ ...lib, requires: { kotlin: 'latest' } }] }, /requires/);
  bad({ ...VERSIONS, libraries: [{ ...lib, requires: { nope: 1 } }] }, /requires/);
  bad({ ...VERSIONS, libraries: [{ ...lib, notes: 'x'.repeat(301) }] }, /notes/);
  bad({ ...VERSIONS, libraries: [lib, lib] }, /duplicate/);
  bad({ ...VERSIONS, libraries: Array.from({ length: 201 }, (_, i) => ({ ...lib, coord: `a.b:c${i}` })) }, /at most 200/);
  bad({ ...VERSIONS, extra: 1 }, /unknown key/);
});

test('the shipped versions.json is valid, marked unverified and vendored', () => {
  const v = loadVersions();
  assert.equal(v.verified, false);
  assert.match(v.dataNote, /audit/);
  assert.equal(v.asOf, '2026-11-20');
  assert.ok(v.libraries.length >= 25 && v.libraries.length <= 40);
  assert.ok('catalog/versions.json' in expectedToolHashes(SKILL, CATALOG_DIR));
  assert.ok('scripts/lib-update.js' in expectedToolHashes(SKILL, CATALOG_DIR));
});

test('references/library-updates.md scans clean and is English documentation', () => {
  const text = fs.readFileSync(path.join(SKILL, 'references/library-updates.md'), 'utf8');
  assert.deepEqual(scanInstructions(text), []);
  for (const w of ['security', 'verify', 'Kotlin', 'AGP', 'Compose compiler', 'KSP', 'requires']) assert.ok(text.includes(w), w);
});

function cli(args, { versions } = {}) {
  const extra = versions ? ['--versions-dir', versions] : [];
  return spawnSync(process.execPath, ['--import', HELPER, CLI, ...args, ...extra], { encoding: 'utf8' });
}

test('CLI: json and md output, scope, exit codes, --out', () => {
  const root = project();
  const vdir = path.join(tmp, 'v');
  fs.mkdirSync(vdir);
  fs.writeFileSync(path.join(vdir, 'versions.json'), JSON.stringify(VERSIONS));
  const j = cli([root, '--format', 'json', '--today', '2026-11-10'], { versions: vdir });
  assert.equal(j.status, 0, j.stderr);
  const data = JSON.parse(j.stdout);
  assert.equal(data.groups[0].id, 'security');
  assert.ok(!j.stdout.includes('AKIAIOSFODNN7EXAMPLE'));
  const md = cli([root, '--format', 'md', '--today', '2026-11-10', '--scope', ':feature:home'], { versions: vdir });
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /^# Library update plan/);
  assert.ok(!md.stdout.includes('okhttp'));
  assert.equal(cli([root, '--scope', ':nope'], { versions: vdir }).status, 1);
  assert.equal(cli([root, '--today', 'yesterday'], { versions: vdir }).status, 1);
  assert.equal(cli([root, '--bogus']).status, 1);
  assert.equal(cli([]).status, 1);
  assert.equal(cli([tmp]).status, 2);
  const out = path.join(tmp, 'plan.md');
  assert.equal(cli([root, '--format', 'md', '--out', out], { versions: vdir }).status, 0);
  assert.ok(fs.readFileSync(out, 'utf8').startsWith('# Library update plan'));
  assert.equal(cli([root, '--out', path.join(root, 'plan.md')], { versions: vdir }).status, 1);
  assert.ok(!fs.existsSync(path.join(root, 'plan.md')));
});

test('CLI: the shipped versions.json runs through the vendored default', () => {
  const r = spawnSync(process.execPath, ['--import', HELPER, CLI, path.resolve('test/fixtures/legacy-java-mvp'), '--format', 'md'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unverified/i);
});
