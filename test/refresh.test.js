import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeAiDir } from '../skill/scripts/lib/aidir.js';
import { refreshAiDir, migrateLayout } from '../skill/scripts/lib/refresh.js';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { generatedHeader } from '../skill/scripts/lib/knowledge.js';

const FIXTURE = path.resolve('test/fixtures/legacy-java-mvp');
const SKILL = path.resolve('skill');
const NOW = new Date('2026-11-19T00:00:00Z');
const LATER = new Date('2026-12-03T00:00:00Z');
const NEW_VERSION = '2026.12.0';
const NEW_ID = 'mvi-orbit';
const helper = path.resolve('test/helpers/no-network.mjs');
const cli = (...args) => spawnSync(process.execPath, ['--import', helper, path.resolve('skill/scripts/refresh.js'), ...args], { encoding: 'utf8' });

let tmp;
let root;
let bumped;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-refresh-'));
  root = path.join(tmp, 'proj');
  fs.cpSync(FIXTURE, root, { recursive: true });
  bumped = path.join(tmp, 'catalog');
  fs.cpSync(path.join(SKILL, 'catalog'), bumped, { recursive: true });
  const metaFile = path.join(bumped, 'catalog.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.catalogVersion = NEW_VERSION;
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  const dimFile = path.join(bumped, 'dimensions', 'presentation.json');
  const dim = JSON.parse(fs.readFileSync(dimFile, 'utf8'));
  const target = dim.entries.find((e) => e.id === 'mvvm-livedata');
  target.status = 'deprecated';
  target.successors.push(NEW_ID);
  dim.entries.push({
    id: NEW_ID, name: 'MVI with Orbit', era: 5, status: 'current', since: '2026-12', successors: [],
    detect: { imports: ['org.orbitmvi.orbit.ContainerHost'] },
  });
  fs.writeFileSync(dimFile, JSON.stringify(dim, null, 2));
  assert.equal(loadCatalog(bumped).catalogVersion, NEW_VERSION);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const init = () => writeAiDir(root, { now: NOW, toolVersion: '1.0.0' });
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const refresh = (opts = {}) => refreshAiDir(root, { now: LATER, toolVersion: '1.1.0', catalogDir: bumped, ...opts });

function writeRecs() {
  const cat = loadCatalog();
  const recs = {
    schemaVersion: 1,
    catalogVersion: cat.catalogVersion,
    generatedAt: '2026-11-19',
    dimensions: [
      { dimension: 'presentation', current: ['mvp'], target: 'mvvm-livedata', label: 'should', rationale: 'Presenters hold view references; ViewModel survives configuration changes.' },
      { dimension: 'language', current: ['java'], target: 'java8-desugar', label: 'must', rationale: 'Desugaring is the first step toward Kotlin interop.' },
    ],
    steps: [
      { id: 's1', dimension: 'language', from: 'java', to: 'java8-desugar', dependsOn: [] },
      { id: 's2', dimension: 'presentation', from: 'mvp', to: 'mvvm-livedata', dependsOn: ['s1'] },
    ],
  };
  const recPath = path.join(root, '.ai', 'recommendations.json');
  fs.writeFileSync(recPath, JSON.stringify(recs, null, 2));
  const profilePath = path.join(tmp, 'profile.json');
  execFileSync(process.execPath, [path.join(SKILL, 'scripts/scan.js'), root, '--out', profilePath]);
  const r = spawnSync(process.execPath, [path.join(SKILL, 'scripts/recommend-check.js'), recPath, '--profile', profilePath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
}

test('refresh reports catalog, status, new option and candidate changes and rewrites generated files', () => {
  init();
  writeRecs();
  const userFile = '.ai/knowledge/architecture-target.md';
  fs.appendFileSync(path.join(root, userFile), '\nMy own notes.\n');
  const before = fs.readFileSync(path.join(root, userFile));
  const report = refresh();

  assert.deepEqual(report.tool, { from: '1.0.0', to: '1.1.0' });
  assert.deepEqual(report.catalog, { from: loadCatalog().catalogVersion, to: NEW_VERSION });
  assert.deepEqual(report.recommendations.statusChanges, [{ dimension: 'presentation', id: 'mvvm-livedata', from: 'legacy', to: 'deprecated' }]);
  assert.deepEqual(report.recommendations.newOptions, [{ dimension: 'presentation', target: 'mvvm-livedata', successors: [NEW_ID] }]);
  assert.ok(Array.isArray(report.recommendations.violations));
  assert.ok(report.candidates.presentation.added.includes(NEW_ID));
  assert.deepEqual(report.candidates.presentation.removed, []);
  assert.equal(report.candidates.language, undefined);
  assert.ok(report.notes.some((n) => n.includes(NEW_VERSION)));

  assert.ok(fs.readFileSync(path.join(root, userFile)).equals(before));
  assert.ok(report.files.kept.includes(userFile));
  assert.equal(JSON.parse(read('.ai/manifest.json')).catalogVersion, NEW_VERSION);
  assert.equal(JSON.parse(read('.ai/candidates.json')).catalogVersion, NEW_VERSION);

  const md = read('.ai/refresh-report.md');
  assert.ok(md.startsWith(generatedHeader({ date: '2026-12-03', commit: null, catalogVersion: NEW_VERSION })));
  assert.ok(md.includes(NEW_ID));
  for (const h of ['Catalog', 'Candidates', 'Recommendations', 'Rejections', 'Files', 'Notes']) assert.match(md, new RegExp(`^## ${h}$`, 'm'));
  assert.ok(report.files.written.includes('.ai/refresh-report.md'));
});

test('refresh without recommendations.json has a null recommendations section', () => {
  init();
  const report = refresh();
  assert.equal(report.recommendations, null);
  assert.deepEqual(report.rejections, { reopened: [] });
});

test('a rejected ADR whose reopenIf holds appears in rejections.reopened', () => {
  init();
  fs.writeFileSync(
    path.join(root, '.ai/knowledge/adr/0001-no-viewbinding.md'),
    '---\nid: "0001"\ntitle: No ViewBinding\nstatus: rejected\ndate: 2026-11-19\ndimension: ui\ntarget: viewbinding\nreopenIf:\n  - present:mvp\nreason: "later"\n---\n\n# x\n',
  );
  const report = refresh();
  assert.equal(report.rejections.reopened.length, 1);
  assert.equal(report.rejections.reopened[0].target, 'viewbinding');
  assert.equal(report.rejections.reopened[0].condition, 'present:mvp');
});

test('an invalid ADR aborts refresh before anything is written', () => {
  init();
  fs.writeFileSync(path.join(root, '.ai/knowledge/adr/0002-bad.md'), 'no front matter');
  const manifest = read('.ai/manifest.json');
  assert.throws(() => refresh(), /0002-bad\.md/);
  assert.equal(read('.ai/manifest.json'), manifest);
  assert.ok(!fs.existsSync(path.join(root, '.ai/refresh-report.md')));
});

test('a missing old vendored catalog yields empty status diffs and a note', () => {
  init();
  writeRecs();
  fs.rmSync(path.join(root, '.ai/tools/catalog'), { recursive: true });
  const report = refresh();
  assert.deepEqual(report.recommendations.statusChanges, []);
  assert.deepEqual(report.recommendations.newOptions, []);
  assert.ok(report.notes.some((n) => /previous catalog could not be read/.test(n)));
});

test('refresh keeps the member workspace role and local mode from the manifest', () => {
  writeAiDir(root, { now: NOW, toolVersion: '1.0.0', workspace: { role: 'member', hub: '../hub' } });
  const report = refresh();
  assert.equal(report.recommendations, null);
  const m = JSON.parse(read('.ai/manifest.json'));
  assert.deepEqual(m.workspace, { role: 'member', hub: '../hub' });
  assert.equal(m.mode, 'committed');
  assert.ok(!fs.existsSync(path.join(root, '.ai/workflows')));
});

test('refresh refuses a symlinked .ai and writes nothing', () => {
  init();
  const outside = path.join(tmp, 'outside');
  fs.renameSync(path.join(root, '.ai'), outside);
  fs.symlinkSync(outside, path.join(root, '.ai'));
  assert.throws(() => refresh(), /symlink/);
  assert.ok(!fs.existsSync(path.join(outside, 'refresh-report.md')));
});

test('migrateLayout is a no-op for schema 1 without a backup and throws for unknown schemas', () => {
  init();
  const aiDir = path.join(root, '.ai');
  assert.equal(migrateLayout(aiDir, 1, NOW), null);
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.ai.backup')), []);
  assert.throws(() => migrateLayout(aiDir, 0, NOW), /schema/);
});

test('CLI: refresh prints the report JSON; no manifest exits 2; usage exits 1', () => {
  init();
  const ok = cli(root);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok('catalog' in JSON.parse(ok.stdout));
  assert.equal(cli(path.join(tmp, 'nope')).status, 2);
  const fresh = path.join(tmp, 'fresh');
  fs.cpSync(FIXTURE, fresh, { recursive: true });
  const r = cli(fresh);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /run init first/);
  assert.equal(cli().status, 1);
  assert.equal(cli(root, '--bogus').status, 1);
});

test('CLI: refresh exits 1 on an invalid ADR and on a newer manifest schema', () => {
  init();
  fs.writeFileSync(path.join(root, '.ai/knowledge/adr/0002-bad.md'), 'nope');
  assert.equal(cli(root).status, 1);
  fs.rmSync(path.join(root, '.ai/knowledge/adr/0002-bad.md'));
  const m = JSON.parse(read('.ai/manifest.json'));
  m.schemaVersion = 99;
  fs.writeFileSync(path.join(root, '.ai/manifest.json'), JSON.stringify(m));
  assert.equal(cli(root).status, 1);
});
