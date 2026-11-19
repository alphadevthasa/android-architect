// End-to-end lifecycle: init, commit, status, re-init, refresh with a new catalog, workspace propose and confirm.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { refreshAiDir } from '../skill/scripts/lib/refresh.js';

const helper = path.resolve('test/helpers/no-network.mjs');
const CLI = path.resolve('bin/cli.js');
const STATUS = path.resolve('skill/scripts/ai-status.js');
let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
const node = (args, cwd) => spawnSync(process.execPath, ['--import', helper, ...args], { cwd, encoding: 'utf8' });
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-life-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('lifecycle: init, commit, status, re-init, refresh with a bumped catalog', { skip: !hasGit }, () => {
  const root = path.join(tmp, 'proj');
  fs.cpSync(path.resolve('test/fixtures/legacy-java-mvp'), root, { recursive: true });
  git(root, 'init');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'source');

  let r = node([CLI, 'init', '--root', root, '--json'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).written.includes('.ai/manifest.json'));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'add .ai');

  r = node([STATUS, root], root);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).stale, []);

  // Re-init keeps the committed mode and refuses a switch to --local.
  r = node([CLI, 'init', '--root', root, '--json'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(path.join(root, '.ai/manifest.json')).mode, 'committed');
  // Only timestamped JSON may change (the CLI uses the wall clock); generated Markdown keeps its committed header.
  const dirty = git(root, 'status', '--porcelain').split('\n').filter(Boolean);
  assert.deepEqual(dirty.filter((l) => !/\.json$/.test(l)), [], dirty.join('\n'));
  r = node([CLI, 'init', '--root', root, '--local'], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /committed mode/);

  // Refresh against a bumped catalog reports the move.
  const cat = path.join(tmp, 'catalog');
  fs.cpSync(path.resolve('skill/catalog'), cat, { recursive: true });
  const meta = json(path.join(cat, 'catalog.json'));
  const from = meta.catalogVersion;
  meta.catalogVersion = '2099.01.0';
  fs.writeFileSync(path.join(cat, 'catalog.json'), JSON.stringify(meta, null, 2));
  const report = refreshAiDir(root, { now: new Date('2026-12-01T00:00:00Z'), catalogDir: cat, toolVersion: '9.9.9' });
  assert.deepEqual(report.catalog, { from, to: '2099.01.0' });
  assert.equal(json(path.join(root, '.ai/manifest.json')).catalogVersion, '2099.01.0');
  r = node([STATUS, root], root);
  assert.deepEqual(JSON.parse(r.stdout).stale, ['catalog-moved']);

  // A source change moves the commit.
  fs.appendFileSync(path.join(root, 'build.gradle'), '\n// changed\n');
  git(root, 'commit', '-am', 'change');
  r = node([STATUS, root], root);
  assert.deepEqual(JSON.parse(r.stdout).stale, ['commit-moved', 'catalog-moved']);
});

test('lifecycle: bare workspace proposes siblings, explicit paths confirm them', () => {
  const ws = path.join(tmp, 'ws');
  const hub = path.join(ws, 'hub-app');
  const lib = path.join(ws, 'lib-core');
  fs.cpSync(path.resolve('test/fixtures/workspace/hub-app'), hub, { recursive: true });
  fs.cpSync(path.resolve('test/fixtures/workspace/lib-core'), lib, { recursive: true });

  let r = node([CLI, 'init', '--root', hub, '--workspace'], hub);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /init --workspace \.\.\/lib-core/);
  assert.equal(json(path.join(hub, '.ai/repos.json')).repos.find((x) => x.name === 'lib-core').confirmed, false);
  assert.equal(fs.existsSync(path.join(lib, '.ai')), false);

  r = node([CLI, 'init', '--root', hub, '--workspace', '../lib-core', '--json'], hub);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).hub.conflicts, []);
  assert.equal(json(path.join(hub, '.ai/repos.json')).repos.find((x) => x.name === 'lib-core').confirmed, true);
  assert.deepEqual(json(path.join(lib, '.ai/manifest.json')).workspace, { role: 'member', hub: '../hub-app' });
});
