import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { detectStack } from '../skill/scripts/lib/detect.js';
import { parseAdr, loadAdrs, reopenHolds, activeRejections } from '../skill/scripts/lib/adr.js';
import { checkRecommendations } from '../skill/scripts/lib/guardrail.js';

const catalog = loadCatalog();
const fixture = fileURLToPath(new URL('./fixtures/legacy-java-mvp', import.meta.url));
const profile = detectStack(fixture, catalog);
const kmpProfile = { dimensions: { language: { entries: [{ id: 'kmp', units: 0, share: null }] } } };
const template = fs.readFileSync(new URL('../skill/templates/ai/knowledge/adr/0000-template.md', import.meta.url), 'utf8');

const fm = (body) => `---\n${body}\n---\n\n# x\n`;
const rejected = (extra = '') => fm(`id: "0001"\ntitle: No Ktor\nstatus: rejected\ndate: 2026-11-19\ndimension: networking\ntarget: ktor-client\nreopenIf:\n  - present:kmp\nreason: "Team knows OkHttp"${extra}`);
const adr = () => parseAdr(rejected(), '0001-no-ktor.md');

const recs = (label, withStep = false) => ({
  schemaVersion: 1,
  catalogVersion: catalog.catalogVersion,
  generatedAt: '2026-11-19',
  dimensions: [{ dimension: 'networking', current: [], target: 'ktor-client', label, rationale: 'r' }],
  steps: withStep ? [{ id: 's1', dimension: 'networking', from: null, to: 'ktor-client', dependsOn: [], justification: 'x'.repeat(30) }] : [],
});
const r7 = (r) => r.violations.filter((v) => v.rule === 'R7-rejected');

test('parseAdr reads quoted and bare values and list items', () => {
  const a = adr();
  assert.deepEqual(a, {
    id: '0001', title: 'No Ktor', status: 'rejected', date: '2026-11-19',
    dimension: 'networking', target: 'ktor-client', reopenIf: ['present:kmp'], reason: 'Team knows OkHttp', file: '0001-no-ktor.md',
  });
});

test('parseAdr accepts the shipped template with empty reopenIf', () => {
  const a = parseAdr(template, '0000-template.md');
  assert.deepEqual(a.reopenIf, []);
  assert.equal(a.id, '0000');
  assert.equal(a.status, 'proposed');
  assert.equal(a.dimension, '');
});

test('parseAdr rejects unsafe or invalid front matter, prefixed with the file name', () => {
  const cases = [
    ['missing front matter', '# no front matter'],
    ['anchor', fm('id: "1"\ntitle: &anchor x\nstatus: proposed')],
    ['alias', fm('id: "1"\ntitle: *a\nstatus: proposed')],
    ['tag', fm('id: "1"\ntitle: !!str x\nstatus: proposed')],
    ['block scalar', fm('id: "1"\ntitle: |\nstatus: proposed')],
    ['flow collection', fm('id: "1"\ntitle: x\nstatus: proposed\nreopenIf: [present:kmp]')],
    ['flow map', fm('id: "1"\ntitle: {a: b}\nstatus: proposed')],
    ['unknown key', fm('id: "1"\ntitle: x\nstatus: proposed\nowner: me')],
    ['bad status', fm('id: "1"\ntitle: x\nstatus: maybe')],
    ['multi-line value', fm('id: "1"\ntitle: x\n  continued\nstatus: proposed')],
    ['rejected without target', fm('id: "1"\ntitle: x\nstatus: rejected\ndimension: networking')],
  ];
  for (const [name, text] of cases) {
    assert.throws(() => parseAdr(text, 'a.md'), /^Error: a\.md: /, name);
  }
  assert.throws(() => parseAdr(fm('id: "1"\ntitle: x\nstatus: rejected'), 'a.md'), /a\.md: rejected ADR needs dimension and target/);
});

test('reopenHolds supports present/absent only', () => {
  assert.equal(reopenHolds('present:kmp', kmpProfile), true);
  assert.equal(reopenHolds('absent:kmp', kmpProfile), false);
  assert.equal(reopenHolds('absent:kmp', profile), true);
  assert.equal(reopenHolds('present:kmp', profile), false);
  assert.equal(reopenHolds('when the team grows', kmpProfile), false);
});

test('activeRejections splits blocked and reopened, ignoring non-rejected ADRs', () => {
  const accepted = parseAdr(fm('id: "2"\ntitle: x\nstatus: accepted'), '0002.md');
  const a = activeRejections([adr(), accepted], profile);
  assert.equal(a.blocked.length, 1);
  assert.equal(a.reopened.length, 0);
  const b = activeRejections([adr(), accepted], kmpProfile);
  assert.equal(b.blocked.length, 0);
  assert.equal(b.reopened.length, 1);
  assert.equal(b.reopened[0].condition, 'present:kmp');
});

test('R7 blocks must/should rows and steps, not dont/later, and reopens', () => {
  const adrs = [adr()];
  for (const label of ['must', 'should']) {
    const v = r7(checkRecommendations(recs(label), catalog, profile, { adrs }));
    assert.equal(v.length, 1);
    assert.match(v[0].message, /0001-no-ktor\.md/);
    assert.match(v[0].message, /present:kmp/);
  }
  assert.equal(r7(checkRecommendations(recs('dont'), catalog, profile, { adrs })).length, 0);
  assert.equal(r7(checkRecommendations(recs('later'), catalog, profile, { adrs })).length, 0);
  const viaStep = r7(checkRecommendations(recs('dont', true), catalog, profile, { adrs }));
  assert.equal(viaStep.length, 1);
  assert.equal(viaStep[0].step, 's1');
  assert.equal(r7(checkRecommendations(recs('must', true), catalog, kmpProfile, { adrs })).length, 0);
  assert.equal(r7(checkRecommendations(recs('must'), catalog, profile)).length, 0);
});

test('loadAdrs skips the template, sorts by name, and recommend-check honours --adr-dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-'));
  try {
    fs.writeFileSync(path.join(dir, '0000-template.md'), template);
    fs.writeFileSync(path.join(dir, '0002-b.md'), fm('id: "2"\ntitle: b\nstatus: accepted'));
    fs.writeFileSync(path.join(dir, '0001-a.md'), rejected());
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    assert.deepEqual(loadAdrs(dir).map((a) => a.file), ['0001-a.md', '0002-b.md']);

    const cli = fileURLToPath(new URL('../skill/scripts/recommend-check.js', import.meta.url));
    const profFile = path.join(dir, 'profile.json');
    const recFile = path.join(dir, 'recs.json');
    fs.writeFileSync(profFile, JSON.stringify(profile));
    fs.writeFileSync(recFile, JSON.stringify(recs('must')));
    const run = (...a) => spawnSync(process.execPath, [cli, recFile, '--profile', profFile, ...a], { encoding: 'utf8' });
    // Other rules may fire for this synthetic input; only R7 presence is under test.
    assert.ok(!JSON.parse(run().stdout).violations.some((v) => v.rule === 'R7-rejected'));
    const bad = run('--adr-dir', dir);
    assert.equal(bad.status, 1);
    assert.ok(JSON.parse(bad.stdout).violations.some((v) => v.rule === 'R7-rejected'));
    const missing = run('--adr-dir', path.join(dir, 'nope'));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /cannot read ADRs/);
    fs.writeFileSync(path.join(dir, '0003-bad.md'), fm('id: "3"\ntitle: &x\nstatus: proposed'));
    const invalid = run('--adr-dir', dir);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /0003-bad\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
