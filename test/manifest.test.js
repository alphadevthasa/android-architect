import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256File, hashTree } from '../skill/scripts/lib/hash.js';
import { MANIFEST_SCHEMA_VERSION, readManifest, writeManifest } from '../skill/scripts/lib/manifest.js';

const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-man-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sample = () => ({
  schemaVersion: 1,
  toolVersion: '0.1.0',
  catalogVersion: '2026-01-01',
  generatedAt: '2026-11-19T00:00:00.000Z',
  commit: null,
  mode: 'committed',
  workspace: { role: 'member', hub: '../hub' },
  tools: { 'tools/a.js': ABC },
  managed: { 'workflows/x.md': ABC },
});

test('sha256File and hashTree hash known content', () => {
  const dir = path.join(tmp, 'h');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'x.js'), 'abc');
  assert.equal(sha256File(path.join(dir, 'sub', 'x.js')), ABC);
  assert.deepEqual(hashTree(dir), { 'sub/x.js': ABC });
  assert.deepEqual(hashTree(path.join(dir, 'sub'), dir), { 'sub/x.js': ABC });
});

test('hashTree rejects symlinks', () => {
  const dir = path.join(tmp, 'l');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(tmp, 'target'), 'x');
  fs.symlinkSync(path.join(tmp, 'target'), path.join(dir, 'link'));
  assert.throws(() => hashTree(dir), /symlink/);
});

test('manifest round-trips', () => {
  const dir = path.join(tmp, 'ai');
  assert.equal(readManifest(dir), null);
  writeManifest(dir, sample());
  assert.deepEqual(readManifest(dir), sample());
  assert.equal(MANIFEST_SCHEMA_VERSION, 1);
});

test('newer schema and bad JSON throw', () => {
  const dir = path.join(tmp, 'ai2');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...sample(), schemaVersion: 2 }));
  assert.throws(() => readManifest(dir), /newer than supported/);
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{nope');
  assert.throws(() => readManifest(dir), /manifest/);
});
