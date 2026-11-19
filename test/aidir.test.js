import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeAiDir, aiStatus } from '../skill/scripts/lib/aidir.js';
import { hashTree } from '../skill/scripts/lib/hash.js';
import { readManifest } from '../skill/scripts/lib/manifest.js';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';

const FIXTURE = path.resolve('test/fixtures/modern-compose');
const NOW = new Date('2026-11-19T00:00:00Z');
const MARKER = '<!-- android-architect:pointer -->';
let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}
const g = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

let tmp;
let root;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-aidir-'));
  root = path.join(tmp, 'proj');
  fs.cpSync(FIXTURE, root, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const run = (opts = {}) => writeAiDir(root, { now: NOW, toolVersion: '9.9.9', ...opts });
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('first run writes all classes, tools package.json and pointers', () => {
  const r = run();
  for (const f of [
    '.ai/README.md',
    '.ai/manifest.json',
    '.ai/candidates.json',
    '.ai/index/index.json',
    '.ai/knowledge/stack-profile.md',
    '.ai/knowledge/module-map.md',
    '.ai/knowledge/architecture-target.md',
    '.ai/knowledge/conventions.md',
    '.ai/knowledge/components.md',
    '.ai/knowledge/adr/0000-template.md',
    '.ai/migration/roadmap.md',
    '.ai/workflows/02-plan.md',
    '.ai/tools/scripts/index.js',
    '.ai/tools/scripts/ai-status.js',
    '.ai/tools/catalog/catalog.json',
  ]) {
    assert.ok(r.written.includes(f), `written lists ${f}`);
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
  assert.deepEqual([...r.written].sort(), r.written);
  assert.deepEqual(JSON.parse(read('.ai/tools/package.json')), { type: 'module', private: true });
  const m = readManifest(path.join(root, '.ai'));
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.toolVersion, '9.9.9');
  assert.equal(m.generatedAt, NOW.toISOString());
  assert.equal(m.mode, 'committed');
  assert.equal(m.commit, null);
  assert.deepEqual(m.tools, hashTree(path.join(root, '.ai', 'tools')));
  assert.match(read('.ai/knowledge/stack-profile.md'), /^<!-- generated: 2026-11-19 @ no-git, catalog /);
  assert.deepEqual(r.pointers, [
    { file: 'AGENTS.md', action: 'created' },
    { file: 'CLAUDE.md', action: 'created' },
  ]);
  assert.ok(read('AGENTS.md').includes(MARKER));
  const c = JSON.parse(read('.ai/candidates.json'));
  assert.deepEqual(Object.keys(c), ['catalogVersion', 'generatedAt', 'candidates']);
  assert.equal(r.excluded.length, 0);
});

test('vendored index.js query works from the project root', () => {
  run();
  const out = execFileSync(
    process.execPath,
    ['.ai/tools/scripts/index.js', 'query', 'compose', '--index', path.join(root, '.ai/index/index.json')],
    { cwd: root, encoding: 'utf8' },
  );
  assert.ok(JSON.parse(out).length >= 1);
});

test('user-owned files are kept byte for byte', () => {
  run();
  const edits = {
    '.ai/knowledge/architecture-target.md': 'my target\n',
    '.ai/knowledge/adr/0001-x.md': 'my adr\n',
    '.ai/migration/roadmap.md': 'my roadmap\n',
  };
  for (const [rel, text] of Object.entries(edits)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const r = run();
  for (const [rel, text] of Object.entries(edits)) {
    assert.equal(read(rel), text);
    assert.ok(r.kept.includes(rel), `kept lists ${rel}`);
    assert.ok(!r.written.includes(rel));
  }
});

test('edited workflow becomes a conflict with a .new file; unedited is rewritten', () => {
  run();
  const p = '.ai/workflows/02-plan.md';
  fs.writeFileSync(path.join(root, p), 'edited\n');
  const before = read('.ai/workflows/01-read-context.md');
  const r = run();
  assert.equal(read(p), 'edited\n');
  assert.ok(fs.existsSync(path.join(root, p + '.new')));
  assert.deepEqual(r.conflicts, [p]);
  assert.ok(r.written.includes('.ai/workflows/01-read-context.md'));
  assert.equal(read('.ai/workflows/01-read-context.md'), before);
});

test('pointers: needs-confirmation, appended, present, exactly one block', () => {
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# mine\n');
  let r = run();
  assert.equal(r.pointers.find((p) => p.file === 'AGENTS.md').action, 'needs-confirmation');
  assert.equal(read('AGENTS.md'), '# mine\n');
  r = run({ appendPointers: true });
  assert.equal(r.pointers.find((p) => p.file === 'AGENTS.md').action, 'appended');
  assert.ok(read('AGENTS.md').startsWith('# mine\n'));
  r = run({ appendPointers: true });
  assert.equal(r.pointers.find((p) => p.file === 'AGENTS.md').action, 'present');
  assert.equal(read('AGENTS.md').split(MARKER).length - 1, 1);
});

test('--local keeps git status clean and uses CLAUDE.local.md', { skip: !hasGit }, () => {
  g(root, 'init');
  g(root, 'add', '.');
  g(root, 'commit', '-m', 'fixture');
  const r = run({ local: true });
  assert.equal(g(root, 'status', '--porcelain'), '');
  assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')));
  assert.ok(read('CLAUDE.local.md').includes(MARKER));
  assert.deepEqual(r.pointers, [
    { file: 'AGENTS.md', action: 'skipped-local' },
    { file: 'CLAUDE.local.md', action: 'created' },
    { file: 'CLAUDE.md', action: 'skipped-local' },
  ]);
  assert.deepEqual(r.excluded, ['/.ai/', '/CLAUDE.local.md']);
  const m = readManifest(path.join(root, '.ai'));
  assert.equal(m.mode, 'local');
  assert.equal(m.commit.length, 7);
  assert.match(read('.ai/README.md'), /local/);
  const again = run({ local: true });
  assert.equal(again.pointers.find((p) => p.file === 'CLAUDE.local.md').action, 'present');
});

test('--local outside a git repo throws and writes nothing', () => {
  assert.throws(() => run({ local: true }), /needs a git repository/);
  assert.ok(!fs.existsSync(path.join(root, '.ai')));
});

test('.ai as a symlink is refused and the target stays empty', () => {
  const other = path.join(tmp, 'other');
  fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(root, '.ai'));
  assert.throws(() => run(), /refusing to write through a symlink: \.ai/);
  assert.deepEqual(fs.readdirSync(other), []);
});

test('a symlinked file inside .ai is refused', () => {
  run();
  const outside = path.join(tmp, 'outside.md');
  fs.writeFileSync(outside, 'secret');
  fs.rmSync(path.join(root, '.ai/knowledge/conventions.md'));
  fs.symlinkSync(outside, path.join(root, '.ai/knowledge/conventions.md'));
  assert.throws(() => run(), /refusing to write through a symlink/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'secret');
});

test('a symlinked AGENTS.md is refused', () => {
  const outside = path.join(tmp, 'outside.md');
  fs.writeFileSync(outside, 'x');
  fs.symlinkSync(outside, path.join(root, 'AGENTS.md'));
  assert.throws(() => run(), /refusing to write through a symlink: AGENTS\.md/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'x');
});

test('stale tools files are wiped on re-run', () => {
  run();
  fs.writeFileSync(path.join(root, '.ai/tools/scripts/stale.js'), '//');
  run();
  assert.ok(!fs.existsSync(path.join(root, '.ai/tools/scripts/stale.js')));
});

test('catalogDir is used for the manifest version and vendoring', () => {
  const cat = path.join(tmp, 'cat');
  fs.cpSync(path.resolve('skill/catalog'), cat, { recursive: true });
  const meta = JSON.parse(fs.readFileSync(path.join(cat, 'catalog.json'), 'utf8'));
  meta.catalogVersion = '2099.01.01';
  fs.writeFileSync(path.join(cat, 'catalog.json'), JSON.stringify(meta));
  run({ catalogDir: cat });
  assert.equal(readManifest(path.join(root, '.ai')).catalogVersion, '2099.01.01');
  assert.equal(JSON.parse(read('.ai/tools/catalog/catalog.json')).catalogVersion, '2099.01.01');
});

test('recommendations.json and repos.json are listed as kept, never created', () => {
  let r = run();
  assert.ok(!fs.existsSync(path.join(root, '.ai/recommendations.json')));
  assert.ok(!fs.existsSync(path.join(root, '.ai/repos.json')));
  fs.writeFileSync(path.join(root, '.ai/recommendations.json'), '{}');
  r = run();
  assert.ok(r.kept.includes('.ai/recommendations.json'));
  assert.equal(read('.ai/recommendations.json'), '{}');
});

test('aiStatus: fresh, tools-modified, catalog-moved, no-manifest', () => {
  assert.deepEqual(aiStatus(root, { toolCatalogVersion: 'x', toolVersion: '9.9.9' }), { ok: false, stale: ['no-manifest'], manifest: null });
  run();
  const cv = loadCatalog().catalogVersion;
  const s = aiStatus(root, { toolCatalogVersion: cv, toolVersion: '9.9.9' });
  assert.equal(s.ok, true);
  assert.deepEqual(s.stale, []);
  assert.equal(s.manifest.toolVersion, '9.9.9');
  assert.ok(aiStatus(root, { toolCatalogVersion: 'other', toolVersion: '9.9.9' }).stale.includes('catalog-moved'));
  fs.appendFileSync(path.join(root, '.ai/tools/scripts/index.js'), '\n// x\n');
  assert.ok(aiStatus(root, { toolCatalogVersion: cv, toolVersion: '9.9.9' }).stale.includes('tools-modified'));
});

test('aiStatus reports commit-moved', { skip: !hasGit }, () => {
  g(root, 'init');
  g(root, 'add', '.');
  g(root, 'commit', '-m', 'a');
  run();
  const cv = loadCatalog().catalogVersion;
  assert.equal(aiStatus(root, { toolCatalogVersion: cv, toolVersion: '9.9.9' }).ok, true);
  g(root, 'commit', '--allow-empty', '-m', 'b');
  assert.deepEqual(aiStatus(root, { toolCatalogVersion: cv, toolVersion: '9.9.9' }).stale, [], 'an empty commit changes no project file');
  fs.appendFileSync(path.join(root, 'settings.gradle.kts'), '\n// changed\n');
  g(root, 'commit', '-am', 'c');
  assert.deepEqual(aiStatus(root, { toolCatalogVersion: cv, toolVersion: '9.9.9' }).stale, ['commit-moved']);
});

test('committed mode: committing .ai and pointer files is not commit-moved; a source change is', { skip: !hasGit }, () => {
  g(root, 'init');
  g(root, 'add', '.');
  g(root, 'commit', '-m', 'a');
  run();
  g(root, 'add', '.');
  g(root, 'commit', '-m', 'add .ai');
  const cv = loadCatalog().catalogVersion;
  assert.deepEqual(aiStatus(root, { toolCatalogVersion: cv, toolVersion: '9.9.9' }).stale, []);
  // Re-running with no project change does not dirty the committed files.
  run();
  assert.equal(g(root, 'status', '--porcelain'), '');
  assert.deepEqual(aiStatus(root, { toolCatalogVersion: cv, toolVersion: '9.9.9' }).stale, []);
  fs.appendFileSync(path.join(root, 'settings.gradle.kts'), '\n// changed\n');
  g(root, 'commit', '-am', 'src');
  assert.deepEqual(aiStatus(root, { toolCatalogVersion: cv, toolVersion: '9.9.9' }).stale, ['commit-moved']);
});

test('commit-moved in a repo subdirectory looks only at the root', { skip: !hasGit }, () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  fs.renameSync(root, path.join(repo, 'proj'));
  root = path.join(repo, 'proj');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'x');
  g(repo, 'init');
  g(repo, 'add', '.');
  g(repo, 'commit', '-m', 'a');
  run();
  g(repo, 'add', '.');
  g(repo, 'commit', '-m', 'ai');
  const cv = loadCatalog().catalogVersion;
  fs.appendFileSync(path.join(repo, 'other.txt'), 'y');
  g(repo, 'commit', '-am', 'outside');
  assert.deepEqual(aiStatus(root, { toolCatalogVersion: cv, toolVersion: '9.9.9' }).stale, []);
  fs.appendFileSync(path.join(root, 'settings.gradle.kts'), '\n// changed\n');
  g(repo, 'commit', '-am', 'inside');
  assert.deepEqual(aiStatus(root, { toolCatalogVersion: cv, toolVersion: '9.9.9' }).stale, ['commit-moved']);
});

test('an unknown or malformed manifest commit counts as moved', { skip: !hasGit }, () => {
  g(root, 'init');
  g(root, 'add', '.');
  g(root, 'commit', '-m', 'a');
  run();
  const cv = loadCatalog().catalogVersion;
  const file = path.join(root, '.ai/manifest.json');
  for (const commit of ['deadbee', '--output=x', null]) {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    m.commit = commit;
    fs.writeFileSync(file, JSON.stringify(m));
    assert.deepEqual(aiStatus(root, { toolCatalogVersion: cv, toolVersion: '9.9.9' }).stale, ['commit-moved'], String(commit));
  }
  assert.equal(fs.existsSync(path.join(root, 'x')), false);
});

test('--local with root in a repo subdirectory anchors exclude patterns', { skip: !hasGit }, () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  fs.renameSync(root, path.join(repo, 'sub'));
  root = path.join(repo, 'sub');
  g(repo, 'init');
  g(repo, 'add', '.');
  g(repo, 'commit', '-m', 'fixture');
  const r = run({ local: true });
  assert.deepEqual(r.excluded, ['/sub/.ai/', '/sub/CLAUDE.local.md']);
  assert.equal(g(repo, 'status', '--porcelain'), '');
});

const snapshot = () => JSON.stringify([hashTree(path.join(root, '.ai/tools')), read('.ai/manifest.json')]);

test('a symlink in the vendor sources aborts before anything is changed', () => {
  run();
  const before = snapshot();
  const skill = path.join(tmp, 'skill');
  fs.cpSync(path.resolve('skill'), skill, { recursive: true });
  fs.symlinkSync(path.join(tmp, 'outside'), path.join(skill, 'scripts', 'evil.js'));
  assert.throws(() => run({ skillDir: skill }), /refusing to write through a symlink/);
  assert.equal(snapshot(), before);
});

test('vendoring from inside .ai is refused and .ai/tools stays intact', () => {
  run();
  const before = snapshot();
  assert.throws(() => run({ skillDir: path.join(root, '.ai', 'tools') }), /refusing to vendor from inside \.ai/);
  assert.equal(snapshot(), before);
});
