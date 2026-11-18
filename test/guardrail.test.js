import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { detectStack } from '../skill/scripts/lib/detect.js';
import { checkRecommendations } from '../skill/scripts/lib/guardrail.js';

const catalog = loadCatalog();
const fixture = fileURLToPath(new URL('./fixtures/legacy-java-mvp', import.meta.url));
const profile = detectStack(fixture, catalog);

const rec = (steps, over = {}) => ({
  schemaVersion: 1,
  catalogVersion: catalog.catalogVersion,
  generatedAt: '2026-11-19',
  dimensions: [{ dimension: 'presentation', current: ['mvp'], target: 'mvvm-livedata', label: 'must', rationale: 'because' }],
  steps,
  ...over,
});
const step = (o) => ({ id: 's1', dimension: 'presentation', from: 'mvp', to: 'mvvm-livedata', dependsOn: [], ...o });
const rules = (r) => r.violations.map((v) => v.rule);

test('valid single hop passes', () => {
  const r = checkRecommendations(rec([step({})]), catalog, profile);
  assert.deepEqual(r, { ok: true, violations: [] });
});

test('R1 rejects jump to latest', () => {
  const r = checkRecommendations(rec([step({ to: 'circuit-decompose' })]), catalog, profile);
  assert.equal(r.ok, false);
  const v = r.violations.find((x) => x.rule === 'R1-hop');
  assert.equal(v.step, 's1');
  assert.match(v.message, /s1/);
  assert.match(v.message, /circuit-decompose/);
  assert.match(v.message, /mvp/);
});

test('R1 allows justified multi-hop', () => {
  const steps = [
    { id: 'lang1', dimension: 'language', from: 'java', to: 'java8-desugar', dependsOn: [] },
    { id: 'lang2', dimension: 'language', from: 'java8-desugar', to: 'kotlin', dependsOn: ['lang1'] },
    { id: 'as1', dimension: 'async', from: 'rxjava2', to: 'coroutines-flow', dependsOn: ['lang2'] },
    step({ id: 'p1', to: 'udf-stateflow', dependsOn: ['as1'], justification: 'x'.repeat(40) }),
  ];
  const r = checkRecommendations(rec(steps, { dimensions: [{ dimension: 'presentation', current: ['mvp'], target: 'udf-stateflow', label: 'must', rationale: 'r' }] }), catalog, profile);
  assert.deepEqual(r, { ok: true, violations: [] });
  const noJust = steps.map((x) => (x.id === 'p1' ? { ...x, justification: undefined } : x));
  assert.ok(rules(checkRecommendations(rec(noJust), catalog, profile)).includes('R1-hop'));
});

test('R1 rejects unreachable even with justification, and non-current fresh target', () => {
  const a = checkRecommendations(rec([step({ to: 'god-activity', justification: 'x'.repeat(40) })]), catalog, profile);
  assert.ok(rules(a).includes('R1-hop'));
  const b = checkRecommendations(rec([step({ from: null, to: 'mvp' })]), catalog, profile);
  assert.ok(rules(b).includes('R1-hop'));
});

test('R2 requires kotlin before compose', () => {
  const ui = { id: 'ui1', dimension: 'ui', from: 'xml-layouts', to: 'compose', dependsOn: [] };
  const bad = checkRecommendations(rec([ui]), catalog, profile);
  assert.ok(rules(bad).includes('R2-prereq'));
  assert.match(bad.violations.find((v) => v.rule === 'R2-prereq').message, /ui1/);
  const good = checkRecommendations(rec([
    { id: 'lang1', dimension: 'language', from: 'java', to: 'java8-desugar', dependsOn: [] },
    { id: 'lang2', dimension: 'language', from: 'java8-desugar', to: 'kotlin', dependsOn: ['lang1'] },
    { ...ui, dependsOn: ['lang2'] },
  ], { dimensions: [] }), catalog, profile);
  assert.deepEqual(good, { ok: true, violations: [] });
});

test('R6 rejects step from an entry not in profile (chain bypass)', () => {
  const r = checkRecommendations(rec([step({ from: 'udf-stateflow', to: 'circuit-decompose' })]), catalog, profile);
  assert.equal(r.ok, false);
  assert.ok(rules(r).includes('R6-anchor'));
});

test('R6 allows chained from produced by dependsOn ancestor', () => {
  const r = checkRecommendations(rec([
    step({ id: 'a', to: 'mvvm-livedata' }),
    step({ id: 'b', from: 'mvvm-livedata', to: 'mvvm-clean', dependsOn: ['a'] }),
  ], { dimensions: [{ dimension: 'presentation', current: ['mvp'], target: 'mvvm-clean', label: 'should', rationale: 'r' }] }), catalog, profile);
  assert.deepEqual(r, { ok: true, violations: [] });
  const noDep = checkRecommendations(rec([
    step({ id: 'a', to: 'mvvm-livedata' }),
    step({ id: 'b', from: 'mvvm-livedata', to: 'mvvm-clean' }),
  ]), catalog, profile);
  assert.ok(rules(noDep).includes('R6-anchor'));
});

test('R6 cross-checks dimensions current and target', () => {
  const dims = (d) => ({ dimensions: [{ dimension: 'presentation', rationale: 'r', label: 'must', ...d }] });
  const a = checkRecommendations(rec([], dims({ current: ['circuit-decompose'], target: 'circuit-decompose' })), catalog, profile);
  assert.equal(a.ok, false);
  assert.ok(rules(a).includes('R6-anchor'));
  const b = checkRecommendations(rec([], dims({ current: ['mvp'], target: 'mvvm-livedata' })), catalog, profile);
  assert.ok(rules(b).includes('R6-anchor'));
  const c = checkRecommendations(rec([], dims({ current: ['mvp'], target: 'mvvm-livedata', label: 'later' })), catalog, profile);
  assert.equal(c.ok, true);
  const d = checkRecommendations(rec([], dims({ current: ['mvp'], target: null, label: 'dont' })), catalog, profile);
  assert.equal(d.ok, true);
});

test('R2 satisfied by profile entry with share null; other-dimension step does not satisfy', () => {
  const ui = { id: 'ui1', dimension: 'ui', from: 'xml-layouts', to: 'compose', dependsOn: [] };
  const withNull = { ...profile, dimensions: { ...profile.dimensions, language: { entries: [{ id: 'kotlin', share: null }] } } };
  assert.ok(!rules(checkRecommendations(rec([ui]), catalog, withNull)).includes('R2-prereq'));
  const other = checkRecommendations(rec([
    { id: 'x', dimension: 'presentation', from: 'mvp', to: 'mvvm-livedata', dependsOn: [] },
    { ...ui, dependsOn: ['x'] },
  ]), catalog, profile);
  assert.ok(rules(other).includes('R2-prereq'));
});

test('R3 rejects self and cyclic dependsOn', () => {
  const self = checkRecommendations(rec([step({ dependsOn: ['s1'] })]), catalog, profile);
  assert.ok(rules(self).includes('R3-order'));
  const cyc = checkRecommendations(rec([step({ id: 'a', dependsOn: ['b'] }), step({ id: 'b', dependsOn: ['a'] })]), catalog, profile);
  assert.ok(rules(cyc).includes('R3-order'));
});

test('R5 rejects duplicate step id', () => {
  const r = checkRecommendations(rec([step({}), step({})]), catalog, profile);
  assert.ok(r.violations.some((v) => v.rule === 'R5-shape' && /duplicate/.test(v.message)));
});

test('R3 rejects forward and unknown dependsOn', () => {
  const r = checkRecommendations(rec([step({ id: 'a', dependsOn: ['b'] }), step({ id: 'b', from: 'mvvm-livedata', to: 'mvvm-clean' })]), catalog, profile);
  assert.ok(rules(r).includes('R3-order'));
  const u = checkRecommendations(rec([step({ dependsOn: ['nope'] })]), catalog, profile);
  assert.ok(rules(u).includes('R3-order'));
});

test('R4 rejects unknown entry and dimension', () => {
  const a = checkRecommendations(rec([step({ to: 'nonsense' })]), catalog, profile);
  assert.ok(rules(a).includes('R4-unknown-id'));
  const b = checkRecommendations(rec([step({ dimension: 'nope' })]), catalog, profile);
  assert.ok(rules(b).includes('R4-unknown-id'));
});

test('R5 rejects wrong catalogVersion, bad label, bad tags', () => {
  assert.ok(rules(checkRecommendations(rec([step({})], { catalogVersion: 'bogus' }), catalog, profile)).includes('R5-shape'));
  const bad = rec([step({})]);
  bad.dimensions[0].label = 'maybe';
  assert.ok(rules(checkRecommendations(bad, catalog, profile)).includes('R5-shape'));
  assert.ok(rules(checkRecommendations(rec([step({ tags: ['risky'] })]), catalog, profile)).includes('R5-shape'));
  assert.equal(checkRecommendations(rec([step({ tags: ['decision'] })]), catalog, profile).ok, true);
  assert.equal(checkRecommendations(null, catalog, profile).ok, false);
});

test('recommend-check CLI exit codes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const p = path.join(dir, 'profile.json');
  fs.writeFileSync(p, JSON.stringify(profile));
  const cli = fileURLToPath(new URL('../skill/scripts/recommend-check.js', import.meta.url));
  const run = (recs) => {
    const f = path.join(dir, 'r.json');
    fs.writeFileSync(f, JSON.stringify(recs));
    return spawnSync(process.execPath, [cli, f, '--profile', p], { encoding: 'utf8', cwd: dir });
  };
  const bad = run(rec([step({ to: 'circuit-decompose' })]));
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  const good = run(rec([step({})]));
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).ok, true);
  const missing = spawnSync(process.execPath, [cli, path.join(dir, 'nope.json'), '--profile', p], { encoding: 'utf8', cwd: dir });
  assert.equal(missing.status, 2);
  const cand = execFileSync(process.execPath, [fileURLToPath(new URL('../skill/scripts/candidates.js', import.meta.url)), fixture], { encoding: 'utf8', cwd: dir });
  assert.deepEqual(JSON.parse(cand).presentation.current, ['mvp']);
});
