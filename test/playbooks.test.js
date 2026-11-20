import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { detectStack } from '../skill/scripts/lib/detect.js';
import { writeAiDir } from '../skill/scripts/lib/aidir.js';
import { expectedToolHashes } from '../skill/scripts/lib/integrity.js';
import {
  loadPlaybooks, loadPlaybookFile, validatePlaybooks, applyPlaybook, parsePlaybook, MAX_UNITS,
} from '../skill/scripts/lib/playbooks.js';

const SKILL = path.resolve('skill');
const CATALOG_DIR = path.join(SKILL, 'catalog');
const EXAMPLE = path.join(CATALOG_DIR, 'playbooks/_example-seam.md');
const CLI = path.join(SKILL, 'scripts/playbook.js');
const HELPER = path.resolve('test/helpers/no-network.mjs');
const LEGACY = path.resolve('test/fixtures/legacy-java-mvp');
const catalog = loadCatalog();
const GOOD = fs.readFileSync(EXAMPLE, 'utf8');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-playbooks-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const withPair = (from, to, text = GOOD) => text.replace(/okhttp-retrofit/g, from).replace(/ktor-client/g, to);
const put = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f; };
const parse = (text) => parsePlaybook(text, 'x.md');

test('the documented example loads and validates against the catalog', () => {
  const p = loadPlaybookFile(EXAMPLE);
  assert.equal(p.id, 'okhttp-retrofit--to--ktor-client');
  assert.equal(p.irreversible, false);
  assert.equal(p.kmpOnly, true);
  assert.equal(p.verified, false);
  assert.deepEqual(p.worthIf, ['present:kmp']);
  assert.equal(p.securityChecklist.length, 3);
  assert.deepEqual(validatePlaybooks([p], catalog), []);
});

test('loadPlaybooks skips README.md and underscore files and checks the file name', () => {
  put('README.md', '# readme');
  put('_draft.md', 'not a playbook');
  put('okhttp-retrofit--to--ktor-client.md', GOOD);
  assert.equal(loadPlaybooks(tmp).length, 1);
  put('wrong-name.md', GOOD);
  assert.throws(() => loadPlaybooks(tmp), /wrong-name\.md: file name must be/);
});

const malformed = {
  'missing section': (t) => t.replace('## Pitfalls', '## Gotchas'),
  'sections out of order': (t) => t.replace('## Pitfalls', '## TMP').replace('## Tests', '## Pitfalls').replace('## TMP', '## Tests'),
  'one security item': (t) => t.replace(/- Tokens and headers.*\n/, '').replace(/- Cleartext.*\n/, ''),
  'from equals to': (t) => t.replace(/ktor-client/g, 'okhttp-retrofit'),
  'unknown key': (t) => t.replace('verified: false', 'verified: false\nowner: me'),
  'irreversible maybe': (t) => t.replace('irreversible: false', 'irreversible: maybe'),
  'quoted boolean': (t) => t.replace('irreversible: false', 'irreversible: "false"'),
  'bad worthIf': (t) => t.replace('present:kmp', 'kmp'),
  'bad date': (t) => t.replace('asOf: 2026-11-20', 'asOf: yesterday'),
  'empty section': (t) => t.replace(/## Rollback[\s\S]*$/, '## Rollback\n'),
  'duplicate section': (t) => t + '\n## Rollback\n\nAgain.\n',
  'yaml anchor': (t) => t.replace('title: Retrofit', 'title: &a Retrofit'),
};
for (const [name, mutate] of Object.entries(malformed)) {
  test(`malformed playbook throws a file-prefixed error: ${name}`, () => {
    assert.throws(() => parse(mutate(GOOD)), /^Error: x\.md: /);
  });
}

test('a heading inside a code fence does not count as a section', () => {
  const t = GOOD.replace('4. When every', '```\n## Not a section\n```\n4. When every');
  assert.equal(parse(t).sections.Steps.includes('## Not a section'), true);
});

test('validatePlaybooks rejects unknown entries, non-reachable targets and thin Steps', () => {
  const p = parse(GOOD);
  const errs = (x) => validatePlaybooks([x], catalog).join('\n');
  assert.match(errs({ ...p, from: 'nope', id: 'nope--to--ktor-client' }), /from "nope" is not an entry of "networking"/);
  assert.match(errs({ ...p, dimension: 'di' }), /from "okhttp-retrofit" is not an entry of "di"/);
  assert.match(errs({ ...p, from: 'ktor-client', to: 'volley' }), /not reachable from/);
  assert.match(errs({ ...p, sections: { ...p.sections, Steps: 'Just do it.' } }), /Steps must mention the seam/);
  assert.match(validatePlaybooks([p, p], catalog).join('\n'), /duplicate playbook id/);
});

const profileWith = (extra = {}) => ({
  modules: [{ path: ':app', dir: 'app' }, { path: ':app:core', dir: 'app/core' }, { path: ':', dir: '' }],
  dimensions: {
    networking: { entries: [{ id: 'okhttp-retrofit', share: 1, units: 2, evidence: [
      { file: 'app/core/Api.kt', line: 3, signal: 'import retrofit2' },
      { file: 'app/Main.kt', line: 9, signal: 'import retrofit2' },
      { file: 'app/Main.kt', line: 9, signal: 'import okhttp3' },
      { file: 'build.gradle', line: 1, signal: 'gradle' },
    ] }] },
    ...extra,
  },
});

test('applyPlaybook on legacy-java-mvp: present source gives real units and the decision tag', () => {
  const p = parse(GOOD);
  const r = applyPlaybook(p, detectStack(LEGACY, catalog), catalog, { root: LEGACY });
  assert.equal(r.applicable, true);
  assert.ok(r.cutoverUnits.length > 0);
  assert.ok(r.buildFiles.length > 0);
  for (const f of r.buildFiles) assert.ok(!r.cutoverUnits.some((u) => u.file === f), f);
  for (const u of r.cutoverUnits) assert.ok(fs.existsSync(path.join(LEGACY, u.file)), u.file);
  assert.ok(r.tags.includes('decision'));
  assert.equal(r.gated, true);
  assert.equal(r.securityChecklist.length, 3);
});

test('applyPlaybook: absent source is not applicable, with the reason and no units', () => {
  const p = parse(withPair('volley', 'okhttp-retrofit'));
  const r = applyPlaybook(p, detectStack(LEGACY, catalog), catalog);
  assert.equal(r.applicable, false);
  assert.equal(r.reason, 'volley not detected in this project');
  assert.deepEqual(r.cutoverUnits, []);
});

const M = (file, line, kind = 'source') => ({ file, line, kind, signal: 's' });

test('applyPlaybook: owning module is the longest dir prefix, units are per file, sorted; build files are separate', () => {
  const matches = [M('app/core/Api.kt', 3), M('app/Main.kt', 9), M('app/Main.kt', 12), M('build.gradle', 1, 'build'), M('app/build.gradle', 4, 'build'), M('app/src/main/res/layout/a.xml', null, 'resource')];
  const r = applyPlaybook(parse(GOOD), profileWith(), catalog, { matches });
  assert.deepEqual(r.cutoverUnits, [
    { file: 'app/Main.kt', line: 9, module: ':app' },
    { file: 'app/core/Api.kt', line: 3, module: ':app:core' },
    { file: 'app/src/main/res/layout/a.xml', line: null, module: ':app' },
  ]);
  assert.deepEqual(r.buildFiles, ['app/build.gradle', 'build.gradle']);
  assert.equal(r.moreUnits, 0);
  assert.equal(r.totalUnits, 2);
});

test('applyPlaybook caps units and build files and reports the rest', () => {
  const matches = [
    ...Array.from({ length: MAX_UNITS + 5 }, (_, i) => M(`app/F${String(i).padStart(4, '0')}.kt`, 1)),
    ...Array.from({ length: MAX_UNITS + 2 }, (_, i) => M(`m${String(i).padStart(4, '0')}/build.gradle`, 1, 'build')),
  ];
  const r = applyPlaybook(parse(GOOD), profileWith(), catalog, { matches });
  assert.equal(r.cutoverUnits.length, MAX_UNITS);
  assert.equal(r.moreUnits, 5);
  assert.equal(r.buildFiles.length, MAX_UNITS);
  assert.equal(r.moreBuildFiles, 2);
});

function makeProject(dir, n) {
  fs.mkdirSync(path.join(dir, 'app/src/main/java/x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.gradle'), "include ':app'\n");
  fs.writeFileSync(path.join(dir, 'app/build.gradle'), 'dependencies { implementation "com.squareup.retrofit2:retrofit:2.9.0" }\n');
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(dir, `app/src/main/java/x/A${String(i).padStart(3, '0')}.kt`), 'import retrofit2.Retrofit\n');
  }
}

test('real detectStack output: all matching files are listed (not a 5-row sample), the gradle file is a build file', () => {
  const proj = path.join(tmp, 'real');
  makeProject(proj, 8);
  const profile = detectStack(proj, catalog);
  assert.equal(profile.dimensions.networking.entries.find((e) => e.id === 'okhttp-retrofit').evidence.length, 5);
  const r = applyPlaybook(parse(GOOD), profile, catalog, { root: proj });
  assert.equal(r.cutoverUnits.length, 8);
  assert.deepEqual(r.buildFiles, ['app/build.gradle']);
  assert.ok(r.cutoverUnits.every((u) => u.module === ':app' && u.line === 1));
  assert.equal(r.totalUnits, 8);
  assert.deepEqual(applyPlaybook(parse(GOOD), profile, catalog, { root: proj }), r);
});

test('real detectStack output: 250 matching files are capped at 200 with moreUnits 50', () => {
  const proj = path.join(tmp, 'big');
  makeProject(proj, 250);
  const r = applyPlaybook(parse(GOOD), detectStack(proj, catalog), catalog, { root: proj });
  assert.equal(r.cutoverUnits.length, MAX_UNITS);
  assert.equal(r.moreUnits, 50);
  assert.equal(r.totalUnits, 250);
});

test('a 1 MB single-line source file does not stall unit collection', () => {
  const proj = path.join(tmp, 'wide');
  makeProject(proj, 1);
  fs.writeFileSync(path.join(proj, 'app/src/main/java/x/Wide.kt'), 'val s = "' + 'a'.repeat(1_000_000) + '"\n');
  const t = Date.now();
  const r = applyPlaybook(parse(GOOD), detectStack(proj, catalog), catalog, { root: proj });
  assert.equal(r.cutoverUnits.length, 1);
  assert.ok(Date.now() - t < 5000);
});

test('kmpOnly without a worthIf for kmp adds a note on a non-KMP project', () => {
  const p = parse(GOOD.replace('worthIf:\n  - present:kmp\n', 'worthIf:\n'));
  const r = applyPlaybook(p, profileWith(), catalog, { matches: [] });
  assert.equal(r.worth.ok, false);
  assert.match(r.worth.notes[0], /^kmpOnly: this playbook only pays off with KMP/);
});

test('worthIf present:kmp is false with a note without KMP and true with it', () => {
  const p = parse(GOOD);
  const no = applyPlaybook(p, profileWith(), catalog, { matches: [] });
  assert.equal(no.worth.ok, false);
  assert.match(no.worth.notes[0], /^worth-it condition not met: present:kmp\. Retrofit to Ktor is worth it mainly with Kotlin Multiplatform/);
  const yes = applyPlaybook(p, profileWith({ kmp: { entries: [{ id: 'kmp', share: null, units: 0, evidence: [] }] } }), catalog, { matches: [] });
  assert.equal(yes.worth.ok, true);
  assert.deepEqual(yes.worth.notes, []);
});

test('irreversible adds the irreversible tag', () => {
  const r = applyPlaybook(parse(GOOD.replace('irreversible: false', 'irreversible: true')), profileWith(), catalog, { matches: [] });
  assert.deepEqual(r.tags, ['irreversible', 'decision']);
});

const run = (args) => spawnSync(process.execPath, ['--import', HELPER, CLI, ...args], { encoding: 'utf8' });

test('CLI: list exits 0, lists the shipped playbooks and a --dir playbook', () => {
  const r = run(['list']);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /No playbooks/);
  for (const id of ['okhttp-retrofit--to--ktor-client', 'sqliteopenhelper--to--room', 'room--to--sqldelight']) {
    assert.ok(r.stdout.includes(id), id);
  }
  put('okhttp-retrofit--to--ktor-client.md', GOOD);
  const l = run(['list', '--dir', tmp]);
  assert.equal(l.status, 0);
  assert.match(l.stdout, /okhttp-retrofit--to--ktor-client.*okhttp-retrofit -> ktor-client/);
  const j = JSON.parse(run(['list', '--dir', tmp, '--format', 'json']).stdout);
  assert.equal(j[0].to, 'ktor-client');
  assert.equal(run(['show', 'okhttp-retrofit--to--ktor-client', '--dir', tmp]).status, 0);
  assert.equal(run(['show', 'nope', '--dir', tmp]).status, 1);
});

test('CLI: an unknown pair exits 1 and names the known pairs', () => {
  put('okhttp-retrofit--to--ktor-client.md', GOOD);
  const r = run(['apply', 'volley', 'ktor-client', LEGACY, '--dir', tmp]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /known pairs:\nokhttp-retrofit -> ktor-client/);
});

test('CLI: apply on a non-Gradle dir exits 2', () => {
  put('okhttp-retrofit--to--ktor-client.md', GOOD);
  const r = run(['apply', 'okhttp-retrofit', 'ktor-client', tmp, '--dir', tmp]);
  assert.equal(r.status, 2);
});

test('CLI: apply prints json and escaped markdown for a project', () => {
  put('okhttp-retrofit--to--ktor-client.md', GOOD);
  const j = JSON.parse(run(['apply', 'okhttp-retrofit', 'ktor-client', LEGACY, '--dir', tmp]).stdout);
  assert.equal(j.applicable, true);
  assert.ok(j.cutoverUnits.length > 0);
  const md = run(['apply', 'okhttp-retrofit', 'ktor-client', LEGACY, '--dir', tmp, '--format', 'md']).stdout;
  assert.match(md, /## Cutover units/);
  assert.match(md, /ApiModule\.java/);
  assert.match(md, /cutover files \(profile counts \d+ units\)/);
  assert.match(md, /## Build files to update/);
});

test('CLI: hostile file names in evidence cannot break out of a Markdown table row', () => {
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(proj, 'app/src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'settings.gradle'), "include ':app'\n");
  fs.writeFileSync(path.join(proj, 'app/build.gradle'), 'dependencies { implementation "com.squareup.retrofit2:retrofit:2.9.0" }\n');
  fs.writeFileSync(path.join(proj, 'app/src/a|b\n# evil\u202e.kt'), 'import retrofit2.Retrofit\n');
  const dir = path.join(tmp, 'pb');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'okhttp-retrofit--to--ktor-client.md'), GOOD);
  const md = run(['apply', 'okhttp-retrofit', 'ktor-client', proj, '--dir', dir, '--format', 'md']).stdout;
  assert.doesNotMatch(md, /^# evil/m);
  assert.match(md, /a\\\|b # evil \.kt/);
  assert.doesNotMatch(md, /[\u202e\u2028]/);
});

test('the shipped playbooks folder is vendored into .ai/tools and covered by the tool hashes', () => {
  const root = path.join(tmp, 'p');
  fs.cpSync(LEGACY, root, { recursive: true });
  writeAiDir(root, { now: new Date('2026-11-20T00:00:00Z'), toolVersion: '0.4.0', skillDir: SKILL, catalogDir: CATALOG_DIR });
  assert.ok(fs.existsSync(path.join(root, '.ai/tools/catalog/playbooks')));
  assert.ok(fs.existsSync(path.join(root, '.ai/tools/catalog/playbooks/README.md')));
  const hashes = expectedToolHashes(SKILL, CATALOG_DIR);
  assert.ok('catalog/playbooks/README.md' in hashes);
  assert.ok('catalog/playbooks/_example-seam.md' in hashes);
  assert.ok('scripts/playbook.js' in hashes);
  assert.ok(execFileSync(process.execPath, [path.join(root, '.ai/tools/scripts/playbook.js'), 'list'], { encoding: 'utf8' }).includes('Migration playbooks'));
});
