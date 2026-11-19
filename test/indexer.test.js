import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, queryIndex } from '../skill/scripts/lib/indexer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'modern-compose');
const opts = { now: new Date('2026-11-19T00:00:00Z'), commit: 'abc1234', catalogVersion: '2026.11.0' };

test('indexes the fixture and finds a class', () => {
  const idx = buildIndex(fixture, opts);
  assert.equal(idx.schemaVersion, 1);
  assert.equal(idx.generatedAt, '2026-11-19T00:00:00.000Z');
  assert.equal(idx.commit, 'abc1234');
  assert.ok(idx.docs.some((d) => d.kind === 'gradle'));
  const hits = queryIndex(idx, 'UserDao');
  assert.equal(hits[0].kind, 'source');
  assert.equal(hits[0].title, 'UserDao');
  assert.ok(hits[0].line >= 1);
  assert.equal(typeof hits[0].score, 'number');
});

test('kind filter and limit', () => {
  const idx = buildIndex(fixture, opts);
  assert.ok(queryIndex(idx, 'room', { kind: 'gradle' }).every((h) => h.kind === 'gradle'));
  assert.ok(queryIndex(idx, 'home', { limit: 1 }).length <= 1);
});

test('deterministic', () => {
  assert.deepEqual(buildIndex(fixture, opts), buildIndex(fixture, opts));
});

function tmpProject() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-idx-'));
  fs.writeFileSync(path.join(d, 'settings.gradle.kts'), 'rootProject.name = "x"\n');
  return d;
}

test('skips files over 1 MB and indexes .ai/knowledge docs', () => {
  const d = tmpProject();
  try {
    fs.mkdirSync(path.join(d, 'src'));
    fs.writeFileSync(path.join(d, 'src', 'Big.kt'), 'class HugeThing\n' + '// pad\n'.repeat(300000));
    fs.mkdirSync(path.join(d, '.ai', 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(d, '.ai', 'knowledge', 'x.md'), '# Top\n\n## Payments seam\nthe payments gateway\n');
    const idx = buildIndex(d, opts);
    assert.deepEqual(queryIndex(idx, 'HugeThing'), []);
    const hits = queryIndex(idx, 'payments');
    assert.equal(hits[0].kind, 'doc');
    assert.equal(hits[0].title, 'Payments seam');
    assert.equal(hits[0].path, '.ai/knowledge/x.md');
    assert.equal(hits[0].line, 3);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('does not follow a symlinked .ai/knowledge', () => {
  const d = tmpProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-out-'));
  try {
    fs.writeFileSync(path.join(outside, 'y.md'), '# Secretdoc\n');
    fs.mkdirSync(path.join(d, '.ai'));
    fs.symlinkSync(outside, path.join(d, '.ai', 'knowledge'));
    assert.deepEqual(queryIndex(buildIndex(d, opts), 'secretdoc'), []);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
