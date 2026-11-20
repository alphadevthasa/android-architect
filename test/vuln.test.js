import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, validateCatalog } from '../skill/scripts/lib/catalog.js';
import { parseRange } from '../skill/scripts/lib/vuln.js';
import { detectStack, compareVersions } from '../skill/scripts/lib/detect.js';
import { renderProfileMarkdown } from '../skill/scripts/lib/report.js';

const catalog = loadCatalog();
const meta = { schemaVersion: 1, catalogVersion: 'x', asOf: '2026-11-19', dimensions: ['d'] };
const adv = (extra = {}) => ({
  coord: 'a.b:c', range: '<1.0', id: 'CVE-1', severity: 'high', summary: 's', source: 'https://example.invalid/x', ...extra,
});
const raw = (v) => ({
  meta,
  dimensions: [{ id: 'd', name: 'D', entries: [{
    id: 'e', name: 'e', era: 1, status: 'current', successors: [],
    detect: { gradle: [{ coord: 'a.b:c' }, { coord: 'p.q:' }] }, vulnerableVersions: v,
  }] }],
});

test('parseRange comparators, AND and OR', () => {
  assert.equal(parseRange('<2.8.9')('2.8.8'), true);
  assert.equal(parseRange('<2.8.9')('2.8.9'), false);
  const r = parseRange('>=1.0 <1.5 || >=2.0 <2.1');
  assert.deepEqual(['1.2', '2.0.5', '1.5'].map(r), [true, true, false]);
  assert.equal(parseRange('=1.0')('1.0.0'), true);
  assert.equal(parseRange('<=2')('2.0.1'), false);
});

test('parseRange compares numerically and ignores qualifiers', () => {
  assert.equal(parseRange('<2.10')('2.9'), true);
  assert.equal(parseRange('<2.8.9')('2.8.9-android'), false);
  assert.equal(parseRange('<2.8.9')('2.8.9-jre'), false);
  assert.equal(parseRange('<2.8.9')('2.8.9.Final'), false);
  assert.equal(parseRange('<2.8.9')('2.8.8-android'), true);
  assert.equal(parseRange('<2.8.9')('2.10.1'), false);
  assert.equal(compareVersions('2.8.9-rc1', '2.8.9'), 0);
});

test('parseRange rejects anything outside the grammar', () => {
  for (const bad of ['~1', '', ' ', '<', '<1 ||', '|| <1', '<1 || || <2', '>=1.x', '^1.0', '1.0', '<1 <', '<1.', '< 1']) {
    assert.throws(() => parseRange(bad), /invalid range/, bad);
  }
});

test('parseRange stays fast on long input', () => {
  const long = Array.from({ length: 20000 }, () => '<1.0').join(' ');
  const t = Date.now();
  assert.throws(() => parseRange(long + ' x'), (e) => e.message.length < 100);
  assert.ok(Date.now() - t < 1000);
});

test('validator accepts a good advisory and rejects bad ones', () => {
  assert.deepEqual(validateCatalog(raw([adv()])), []);
  assert.deepEqual(validateCatalog(raw([adv({ coord: 'p.q:r' })])), []);
  const bad = (a, re) => assert.ok(validateCatalog(raw([a])).some((e) => re.test(e)), re.source);
  const { source, ...noSource } = adv();
  bad(noSource, /needs source/);
  bad(adv({ source: 'http://example.invalid/x' }), /https/);
  bad(adv({ coord: 'x.y:z' }), /not one of detect\.gradle coords/);
  bad(adv({ range: '~1' }), /invalid range/);
  bad(adv({ severity: 'urgent' }), /severity/);
  assert.ok(validateCatalog(raw('nope')).some((e) => /must be an array/.test(e)));
});

test('shipped gson advisory is present', () => {
  const g = catalog.entry('serialization', 'gson').vulnerableVersions[0];
  assert.equal(g.coord, 'com.google.code.gson:gson');
  assert.equal(g.id, 'CVE-2022-25647');
  assert.equal(g.range, '<2.8.9');
});

function project(dep) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vuln-'));
  fs.writeFileSync(path.join(dir, 'settings.gradle'), "include ':app'\n");
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'build.gradle'),
    `plugins { id 'com.android.application' }\ndependencies {\n    ${dep}\n}\n`);
  return dir;
}
const scan = (dep) => {
  const dir = project(dep);
  try { return detectStack(dir, catalog); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('vulnerable gson version is reported with file and line', () => {
  const p = scan("implementation 'com.google.code.gson:gson:2.8.6'");
  assert.equal(p.security.vulnerable.length, 1);
  const v = p.security.vulnerable[0];
  assert.equal(v.id, 'CVE-2022-25647');
  assert.equal(v.coord, 'com.google.code.gson:gson');
  assert.equal(v.version, '2.8.6');
  assert.equal(v.file, 'app/build.gradle');
  assert.equal(v.line, 3);
  assert.equal(v.entry, 'gson');
  assert.equal(v.dimension, 'serialization');
  assert.deepEqual(p.security.unresolvedChecks, []);
  const md = renderProfileMarkdown(p, catalog);
  assert.match(md, /- \[high\] CVE-2022-25647: com\.google\.code\.gson:gson:2\.8\.6 at app\/build\.gradle:3/);
});

test('fixed gson version is not reported', () => {
  const p = scan("implementation 'com.google.code.gson:gson:2.10.1'");
  assert.deepEqual(p.security.vulnerable, []);
  assert.deepEqual(p.security.unresolvedChecks, []);
});

test('unresolved version is listed in unresolvedChecks, never as safe', () => {
  const p = scan("implementation \"com.google.code.gson:gson:$gsonVersion\"");
  assert.deepEqual(p.security.vulnerable, []);
  assert.deepEqual(p.security.unresolvedChecks, ['com.google.code.gson:gson']);
  assert.match(renderProfileMarkdown(p, catalog), /not checked \(version unresolved\): com\.google\.code\.gson:gson/);
});

test('architecture-current lists vulnerable dependencies', async () => {
  const { renderKnowledge } = await import('../skill/scripts/lib/knowledge.js');
  const p = scan("implementation 'com.google.code.gson:gson:2.8.6'");
  const arch = renderKnowledge(p, [], catalog, { date: '2026-11-20', commit: null, catalogVersion: catalog.catalogVersion })['knowledge/architecture-current.md'];
  assert.match(arch, /## Vulnerable dependencies\n\n- \[high\] CVE-2022-25647: com\.google\.code\.gson:gson:2\.8\.6 at app\/build\.gradle:3/);
});

test('pre-release qualifiers sort below the release (fail closed)', () => {
  const r = parseRange('<2.8.9');
  for (const v of ['2.8.9-rc1', '2.8.9.RC1', '2.8.9-SNAPSHOT', '3.0.0-M2'.replace('3.0.0', '2.8.9'), '2.8.9-alpha', '2.8.9-beta2',
    '2.8.9-cr1', '2.8.9-milestone1', '2.8.9.dev', '2.8.9-preview', '2.8.9-ea', '2.8.9rc1']) {
    assert.equal(r(v), true, v);
  }
  assert.equal(parseRange('<3.0.0')('3.0.0-M2'), true);
  assert.equal(parseRange('<3.0.0')('3.0.0'), false);
  assert.equal(parseRange('>=2.8.9')('2.8.9-rc1'), false);
  assert.equal(parseRange('<2.8.9')('2.8.9-earlybird'), false);
});

test('dynamic versions are never reported, only listed as unchecked', () => {
  for (const v of ['latest.release', '2.+', '+', '[2.8,3.0)', '2.8.$x']) {
    const p = scan(`implementation 'com.google.code.gson:gson:${v}'`);
    assert.deepEqual(p.security.vulnerable, [], v);
    assert.deepEqual(p.security.unresolvedChecks, ['com.google.code.gson:gson'], v);
  }
});

test('unknown version-catalog bundle is listed as unresolved alias', () => {
  const p = scan('implementation libs.bundles.x');
  assert.deepEqual(p.security.vulnerable, []);
  assert.equal(p.security.unresolvedAliases.length, 1);
  assert.equal(p.security.unresolvedAliases[0].alias, 'bundles.x');
  assert.equal(p.security.unresolvedAliases[0].file, 'app/build.gradle');
  assert.match(renderProfileMarkdown(p, catalog), /cannot check .*bundles\.x at app\/build\.gradle:3/);
});

test('root build file dependencies are scanned, including buildscript classpath', () => {
  const dir = project("implementation 'androidx.core:core:1.0.0'");
  try {
    fs.writeFileSync(path.join(dir, 'build.gradle'),
      "buildscript {\n  dependencies {\n    classpath 'com.google.code.gson:gson:2.8.6'\n  }\n}\ndependencies {\n  implementation 'com.google.code.gson:gson:2.8.0'\n}\n");
    const p = detectStack(dir, catalog);
    const rows = p.security.vulnerable.map((v) => `${v.file}:${v.line}`).sort();
    assert.deepEqual(rows, ['build.gradle:3', 'build.gradle:7']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const scanWithToml = (dep, toml) => {
  const dir = project(dep);
  try {
    fs.mkdirSync(path.join(dir, 'gradle'));
    fs.writeFileSync(path.join(dir, 'gradle', 'libs.versions.toml'), toml);
    return detectStack(dir, catalog);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const BUNDLE_TOML = [
  '[versions]', 'gson = "2.8.6"', '',
  '[libraries]', 'gson = { module = "com.google.code.gson:gson", version.ref = "gson" }', 'core = "androidx.core:core:1.0.0"', '',
  '[bundles]', 'json = ["gson", "core"]', 'multi = [', '  "gson",', '  "core",', ']', 'broken = ["gson", "nope"]', '',
].join('\n');

test('a version-catalog bundle is expanded into its libraries before the vulnerability check', () => {
  for (const bundle of ['json', 'multi']) {
    const p = scanWithToml(`implementation libs.bundles.${bundle}`, BUNDLE_TOML);
    assert.deepEqual(p.security.unresolvedAliases, [], bundle);
    assert.deepEqual(p.security.vulnerable.map((v) => [v.coord, v.version, v.file, v.line]), [['com.google.code.gson:gson', '2.8.6', 'app/build.gradle', 3]], bundle);
  }
});

test('only truly unresolvable bundles stay unresolved aliases', () => {
  let p = scanWithToml('implementation libs.bundles.broken', BUNDLE_TOML);
  assert.deepEqual(p.security.unresolvedAliases.map((a) => a.alias), ['bundles.broken']);
  assert.equal(p.security.vulnerable.length, 1, 'the resolvable member is still checked');
  p = scanWithToml('implementation libs.bundles.unknown', BUNDLE_TOML);
  assert.deepEqual(p.security.unresolvedAliases.map((a) => a.alias), ['bundles.unknown']);
});
