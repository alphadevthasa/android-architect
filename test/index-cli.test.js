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
