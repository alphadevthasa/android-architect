import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const INIT = path.resolve('skill/scripts/init-ai.js');
const STATUS = path.resolve('skill/scripts/ai-status.js');
const FIXTURE = path.resolve('test/fixtures/modern-compose');
let tmp;
let root;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-initcli-'));
  root = path.join(tmp, 'proj');
  fs.cpSync(FIXTURE, root, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const node = (script, args, cwd = tmp) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('init-ai prints the result JSON and exits 0', () => {
  const r = node(INIT, [root]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.written.includes('.ai/manifest.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.ai/manifest.json'), 'utf8')).toolVersion, '0.1.0');
});

test('init-ai exits 2 for a non-Gradle dir and 1 for usage errors', () => {
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty);
  assert.equal(node(INIT, [empty]).status, 2);
  assert.equal(node(INIT, []).status, 1);
  assert.equal(node(INIT, [root, '--bogus']).status, 1);
});

test('init-ai --local outside a git repo exits 1', () => {
  const r = node(INIT, [root, '--local']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs a git repository/);
  assert.ok(!fs.existsSync(path.join(root, '.ai')));
});

test('init-ai refuses a symlinked .ai with exit 1', () => {
  const other = path.join(tmp, 'other');
  fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(root, '.ai'));
  const r = node(INIT, [root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to write through a symlink/);
  assert.deepEqual(fs.readdirSync(other), []);
});

test('init-ai --append-pointers appends to an existing AGENTS.md', () => {
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# mine\n');
  const r = node(INIT, [root, '--append-pointers']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /android-architect:pointer/);
});

test('--workspace values stop at the next flag', () => {
  const lib = path.join(tmp, 'lib');
  fs.cpSync(path.resolve('test/fixtures/workspace/lib-core'), lib, { recursive: true });
  const r = node(INIT, [root, '--workspace', '../lib', '--append-pointers']);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(root, '.ai/manifest.json'), 'utf8'));
  assert.deepEqual(m.workspace, { role: 'hub', hub: '.' });
  assert.deepEqual(Object.keys(JSON.parse(r.stdout).members), ['lib']);
});

test('ai-status: exit 2 without manifest, exit 0 with stale info, vendored copy works', () => {
  let r = node(STATUS, [root]);
  assert.equal(r.status, 2);
  assert.equal(node(INIT, [root]).status, 0);
  r = node(STATUS, [root]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).stale, []);
  r = node(path.join(root, '.ai/tools/scripts/ai-status.js'), [], root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  fs.appendFileSync(path.join(root, '.ai/tools/scripts/index.js'), '\n//x\n');
  r = node(STATUS, [root]);
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).stale.includes('tools-modified'));
});
