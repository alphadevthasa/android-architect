import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeAiDir, aiStatus } from '../skill/scripts/lib/aidir.js';
import { expectedToolHashes, verifyTools } from '../skill/scripts/lib/integrity.js';
import { refreshAiDir } from '../skill/scripts/lib/refresh.js';
import { hashTree } from '../skill/scripts/lib/hash.js';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';

const FIXTURE = path.resolve('test/fixtures/modern-compose');
const SKILL = path.resolve('skill');
const CATALOG = path.join(SKILL, 'catalog');
const HELPER = path.resolve('test/helpers/no-network.mjs');
const CLI = path.resolve('bin/cli.js');
const STATUS = path.join(SKILL, 'scripts/ai-status.js');
const VERSION = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version;
const NOW = new Date('2026-11-20T00:00:00Z');
const REFUSAL = '.ai/tools was modified since it was generated; run "refresh" with the installed android-architect, or rerun with --trust-modified-tools';

let tmp;
let root;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-integrity-'));
  root = path.join(tmp, 'proj');
  fs.cpSync(FIXTURE, root, { recursive: true });
  writeAiDir(root, { now: NOW, toolVersion: VERSION, skillDir: SKILL, catalogDir: CATALOG });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const opts = { skillDir: SKILL, catalogDir: CATALOG, toolVersion: VERSION };
const tools = (rel) => path.join(root, '.ai/tools', rel);
const manifestFile = () => path.join(root, '.ai/manifest.json');
const readManifest = () => JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
const writeManifest = (m) => fs.writeFileSync(manifestFile(), JSON.stringify(m, null, 2) + '\n');
const tamper = () => fs.appendFileSync(tools('scripts/index.js'), '\n// tampered\n');
const node = (args, cwd = root) => spawnSync(process.execPath, ['--import', HELPER, ...args], { cwd, encoding: 'utf8' });

test('expectedToolHashes has the same keys and hashes as manifest.tools after writeAiDir', () => {
  const expected = expectedToolHashes(SKILL, CATALOG);
  assert.deepEqual(expected, readManifest().tools);
  assert.ok(expected['package.json']);
  assert.ok(expected['scripts/index.js']);
  assert.ok(expected['catalog/catalog.json']);
});

test('verifyTools is ok on a fresh .ai', () => {
  assert.deepEqual(verifyTools(root, opts), { status: 'ok', changed: [], added: [], removed: [] });
});

test('an edited vendored script is modified', () => {
  tamper();
  const v = verifyTools(root, opts);
  assert.equal(v.status, 'modified');
  assert.ok(v.changed.includes('scripts/index.js'));
});

test('tools and manifest.tools tampered together are still modified', () => {
  tamper();
  const m = readManifest();
  m.tools = hashTree(path.join(root, '.ai/tools'));
  writeManifest(m);
  const v = verifyTools(root, opts);
  assert.equal(v.status, 'modified');
  assert.deepEqual(v.changed, ['scripts/index.js']);
});

test('an added vendored file is reported as added; a deleted one as removed', () => {
  fs.writeFileSync(tools('scripts/evil.js'), 'process.exit(0)\n');
  fs.rmSync(tools('package.json'));
  const v = verifyTools(root, opts);
  assert.equal(v.status, 'modified');
  assert.deepEqual(v.added, ['scripts/evil.js']);
  assert.deepEqual(v.removed, ['package.json']);
});

test('a manifest written by another tool version is unverifiable', () => {
  writeManifest({ ...readManifest(), toolVersion: '9.9.9' });
  const v = verifyTools(root, opts);
  assert.equal(v.status, 'unverifiable');
  assert.match(v.reason, /9\.9\.9/);
  assert.match(v.reason, /refresh/);
  assert.match(v.reason, /update/);
});

test('verifyTools never takes the expected hashes from the vendored copy itself', () => {
  tamper();
  const vendored = path.join(root, '.ai/tools');
  const v = verifyTools(root, { skillDir: vendored, catalogDir: path.join(vendored, 'catalog'), toolVersion: VERSION });
  assert.equal(v.status, 'unverifiable');
  assert.match(v.reason, /inside \.ai/);
});

test('aiStatus reports tools-modified and tools-unverifiable with a tools section', () => {
  const cv = loadCatalog(CATALOG).catalogVersion;
  let s = aiStatus(root, { toolCatalogVersion: cv, ...opts });
  assert.deepEqual(s.stale, []);
  assert.equal(s.tools.status, 'ok');
  assert.equal(s.tools.trusted, true);
  tamper();
  s = aiStatus(root, { toolCatalogVersion: cv, ...opts });
  assert.deepEqual(s.stale, ['tools-modified']);
  assert.deepEqual(s.tools.changed, ['scripts/index.js']);
  s = aiStatus(root, { toolCatalogVersion: cv, ...opts, toolVersion: '0.0.1' });
  assert.deepEqual(s.stale, ['tools-unverifiable']);
  assert.equal(s.tools.status, 'unverifiable');
});

test('vendored index.js refuses to run after an edit, unless --trust-modified-tools', () => {
  const script = tools('scripts/index.js');
  let r = node([script, 'query', 'x']);
  assert.equal(r.status, 0, r.stderr);
  tamper();
  r = node([script, 'query', 'x']);
  assert.equal(r.status, 3);
  assert.equal(r.stderr.trim(), REFUSAL);
  assert.equal(r.stdout, '');
  r = node([script, 'query', 'x', '--trust-modified-tools']);
  assert.equal(r.status, 0, r.stderr);
});

test('the installed index.js accepts --trust-modified-tools and is not gated', () => {
  tamper();
  const r = node([path.join(SKILL, 'scripts/index.js'), 'query', 'x']);
  assert.equal(r.status, 0, r.stderr);
});

test('vendored ai-status.js does the weaker manifest self-check', () => {
  const script = tools('scripts/ai-status.js');
  let r = node([script, root]);
  assert.equal(r.status, 0, r.stderr);
  let out = JSON.parse(r.stdout);
  assert.equal(out.tools.status, 'self-check-ok');
  assert.equal(out.tools.trusted, false);
  tamper();
  r = node([script, root]);
  assert.equal(r.status, 3);
  assert.equal(r.stderr.trim(), REFUSAL);
  r = node([script, root, '--trust-modified-tools']);
  assert.equal(r.status, 0, r.stderr);
  out = JSON.parse(r.stdout);
  assert.equal(out.tools.status, 'modified');
  assert.equal(out.tools.trusted, false);
  assert.ok(out.stale.includes('tools-modified'));
});

test('a tampered manifest fools the vendored self-check but not the installed ai-status', () => {
  tamper();
  const m = readManifest();
  m.tools = hashTree(path.join(root, '.ai/tools'));
  writeManifest(m);
  let r = node([tools('scripts/ai-status.js'), root]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).tools.status, 'self-check-ok');
  r = node([STATUS, root]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.stale.includes('tools-modified'));
  assert.equal(out.tools.trusted, true);
});

test('refresh is not blocked by modified tools, rewrites them and notes what was modified', () => {
  tamper();
  fs.writeFileSync(tools('scripts/evil.js'), '\n');
  const report = refreshAiDir(root, { now: NOW, ...opts });
  const note = report.notes.find((n) => n.includes('.ai/tools'));
  assert.ok(note, report.notes.join('\n'));
  assert.match(note, /scripts\/index\.js/);
  assert.match(note, /scripts\/evil\.js/);
  assert.equal(verifyTools(root, opts).status, 'ok');
  assert.equal(fs.existsSync(tools('scripts/evil.js')), false);
});

test('refresh on intact tools adds no tools note', () => {
  const report = refreshAiDir(root, { now: NOW, ...opts });
  assert.equal(report.notes.filter((n) => n.includes('.ai/tools')).length, 0, report.notes.join('\n'));
});

test('CLI doctor --root reports the tools status against the installed skill', () => {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  let r = node([CLI, 'install', '--home', home], tmp);
  assert.equal(r.status, 0, r.stderr);
  r = node([CLI, 'doctor', '--home', home, '--root', root], tmp);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^tools: ok$/m);
  tamper();
  r = node([CLI, 'doctor', '--home', home, '--root', root], tmp);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^tools: modified \(1 files\)$/m);
  writeManifest({ ...readManifest(), toolVersion: '9.9.9' });
  r = node([CLI, 'doctor', '--home', home, '--root', root, '--json'], tmp);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).project.aiStatus.tools.status, 'unverifiable');
});

test('CLI doctor --root without an installed skill says the tools are unverifiable', () => {
  const home = path.join(tmp, 'empty-home');
  fs.mkdirSync(home);
  const r = node([CLI, 'doctor', '--home', home, '--root', root], tmp);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^tools: unverifiable \(.+\)$/m);
});
