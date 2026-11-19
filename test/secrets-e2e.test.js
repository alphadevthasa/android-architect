import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAiDir } from '../skill/scripts/lib/aidir.js';
import { listFiles } from '../skill/scripts/lib/walk.js';

const FIXTURE = path.resolve('test/fixtures/secrets');
const NOW = new Date('2026-11-20T00:00:00Z');
const GH = 'ghp_' + 'FAKEfake'.repeat(5).slice(0, 36);
const GOOGLE = 'AIza' + 'FAKEfake'.repeat(5).slice(0, 35);
// Single source of the fake values; never printed on failure.
const FAKES = ['AKIAFAKEFAKEFAKEFAKE', 'fake-store-pass-123', 'fake-api-key-value-123', 'fake-local-secret', GH, GOOGLE, 'FAKEKEYFAKEKEY'];
// Tokens the index would hold if a fake value leaked into it.
const FAKE_TOKENS = ['akiafakefakefakefake', 'fake', 'store', 'pass', 'ghp', 'aiza', 'fakekeyfakekey', 'local'];

function allFiles(dir, rel = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (r === 'tools') return [];
    return e.isDirectory() ? allFiles(path.join(dir, e.name), r) : [r];
  });
}

test('no secret value or derived token reaches .ai/ or the index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-secrets-'));
  try {
    fs.cpSync(FIXTURE, root, { recursive: true });
    assert.ok(!listFiles(root).includes('local.properties'), 'local.properties must never be listed');
    writeAiDir(root, { now: NOW, toolVersion: '9.9.9' });
    const ai = path.join(root, '.ai');
    const files = allFiles(ai);
    assert.ok(files.includes('index/index.json') && files.includes('README.md'));
    for (const f of files) {
      const text = fs.readFileSync(path.join(ai, f), 'utf8');
      for (const s of FAKES) assert.ok(!text.includes(s), `secret leaked into ${f}`);
    }
    const index = JSON.parse(fs.readFileSync(path.join(ai, 'index', 'index.json'), 'utf8'));
    const tokens = new Set([...Object.keys(index.df), ...index.docs.flatMap((d) => Object.keys(d.tf))]);
    for (const t of FAKE_TOKENS) assert.ok(!tokens.has(t), 'a token derived from a secret is in the index');
    assert.ok(tokens.has('redacted'), 'redaction placeholder should be indexed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
