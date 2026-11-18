import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scanPath = path.join(here, '..', 'skill', 'scripts', 'scan.js');
const noNetwork = path.join(here, 'helpers', 'no-network.mjs');
const fx = (n) => path.join(here, 'fixtures', n);
const run = (...args) => execFileSync(process.execPath, ['--import', noNetwork, scanPath, ...args], { encoding: 'utf8', cwd: os.tmpdir() });

test('json output by default', () => {
  const p = JSON.parse(run(fx('modern-compose')));
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.root, '.');
  assert.ok(p.dimensions.ui.entries.some((e) => e.id === 'compose'));
});

test('--format md renders sections', () => {
  const md = run(fx('mixed'), '--format', 'md');
  assert.match(md, /## UI/);
});

test('--out writes to the given file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-scan-'));
  try {
    const out = path.join(tmp, 'profile.json');
    const stdout = run(fx('legacy-java-mvp'), '--out', out);
    assert.equal(stdout, '');
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).sdk.targetSdk, 28);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('non-Gradle directory exits 2', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-scan-'));
  try {
    fs.writeFileSync(path.join(tmp, 'README.md'), 'hi');
    const r = spawnSync(process.execPath, ['--import', noNetwork, scanPath, tmp], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(`not an Android/Gradle project: ${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('bad arguments exit 1 with usage', () => {
  const r = spawnSync(process.execPath, ['--import', noNetwork, scanPath], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: /i);
});
