import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'skill', 'scripts', 'index.js');
const noNetwork = path.join(here, 'helpers', 'no-network.mjs');
const fixture = path.join(here, 'fixtures', 'modern-compose');
const run = (...args) =>
  spawnSync(process.execPath, ['--import', noNetwork, script, ...args], { encoding: 'utf8', cwd: os.tmpdir() });

test('build then query', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-icli-'));
  try {
    const out = path.join(tmp, 'nested', 'index.json');
    const b = run('build', fixture, '--out', out);
    assert.equal(b.status, 0, b.stderr);
    const summary = JSON.parse(b.stdout);
    assert.equal(summary.out, out);
    assert.ok(summary.docs > 0);
    assert.ok('commit' in summary);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).schemaVersion, 1);
    const q = run('query', 'UserDao', '--index', out, '--limit', '3');
    assert.equal(q.status, 0, q.stderr);
    const hits = JSON.parse(q.stdout);
    assert.equal(hits[0].title, 'UserDao');
    assert.ok(hits.length <= 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('missing index exits 2', () => {
  const r = run('query', 'x', '--index', path.join(os.tmpdir(), 'aa-nope', 'index.json'));
  assert.equal(r.status, 2);
});

test('no args exits 1; bad kind exits 1', () => {
  assert.equal(run().status, 1);
  assert.equal(run('query', 'x', '--kind', 'bogus').status, 1);
});

test('build on a non-Gradle dir exits 2', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-icli-'));
  try {
    assert.equal(run('build', tmp).status, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const planted = () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-icli-'));
  fs.cpSync(fixture, proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'victim.txt'), 'keep');
  return proj;
};

test('default build refuses a pre-planted symlink or hardlink at .ai/index/index.json', () => {
  const proj = planted();
  try {
    const target = path.join(proj, '.ai', 'index', 'index.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(proj, 'victim.txt'), target);
    let r = run('build', proj);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /symbolic link/);
    assert.equal(fs.readFileSync(path.join(proj, 'victim.txt'), 'utf8'), 'keep');
    fs.rmSync(target);
    fs.linkSync(path.join(proj, 'victim.txt'), target);
    r = run('build', proj);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /hard-linked/);
    assert.equal(fs.readFileSync(path.join(proj, 'victim.txt'), 'utf8'), 'keep');
    assert.ok(!r.stderr.includes(proj), 'no absolute path');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('default build refuses a symlinked .ai/index folder and writes nothing through it', () => {
  const proj = planted();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-icli-else-'));
  try {
    fs.mkdirSync(path.join(proj, '.ai'));
    fs.symlinkSync(elsewhere, path.join(proj, '.ai', 'index'));
    const r = run('build', proj);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /link or not a folder/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('build --out: a directory that cannot be created gives a clean message without the path', () => {
  const proj = planted();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-icli-out-'));
  try {
    fs.writeFileSync(path.join(tmp, 'afile'), 'x');
    const r = run('build', proj, '--out', path.join(tmp, 'afile', 'sub', 'index.json'));
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), 'cannot create the output directory');
    // a hardlink to a project file is refused and the file is untouched
    fs.linkSync(path.join(proj, 'victim.txt'), path.join(tmp, 'hard.json'));
    const h = run('build', proj, '--out', path.join(tmp, 'hard.json'));
    assert.equal(h.status, 1);
    assert.equal(fs.readFileSync(path.join(proj, 'victim.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
