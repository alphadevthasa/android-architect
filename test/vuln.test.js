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
  assert.equal(parseRange('<2.8.9')('2.8.9-rc1'), false);
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
