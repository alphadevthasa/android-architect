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
const FAKES = ['AKIAFAKEFAKEFAKEFAKE', 'fake-store-pass-123', 'fake-api-key-value-123', 'fake-local-secret', GH, GOOGLE, 'FAKEKEYFAKEKEY',
  'fake-const-api-key-1', 'fake-client-secret-1', 'fake-maps-api-key-1', 'fake-map-api-key-1', 'fake-header-api-key-1',
  'fake-raw-token-12345', 'fake-raw-string-secret', 'fake-env-token-12345', 'fake-env-password-1'];
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

const writeTo = (root, opts = {}) => writeAiDir(root, { now: NOW, toolVersion: '9.9.9', ...opts });
const readAll = (ai) => allFiles(ai).map((f) => [f, fs.readFileSync(path.join(ai, f), 'utf8')]);

test('extraGenerated text is redacted before it is written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-secrets-'));
  try {
    fs.cpSync(FIXTURE, root, { recursive: true });
    writeTo(root, { extraGenerated: { 'refresh-report.md': 'report\ntoken = "fake-extra-token-123"\n' + GH + '\n' } });
    const ai = path.join(root, '.ai');
    const report = fs.readFileSync(path.join(ai, 'refresh-report.md'), 'utf8');
    assert.ok(report.includes('[REDACTED:credential]') && report.includes('[REDACTED:github-token]'));
    for (const [f, text] of readAll(ai)) {
      assert.ok(!text.includes('fake-extra-token-123') && !text.includes(GH), `secret leaked into ${f}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('knowledge and candidates built from project content are redacted and stay valid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-secrets-'));
  try {
    fs.cpSync(FIXTURE, root, { recursive: true });
    // a module whose directory name carries a secret renders into the knowledge files
    fs.mkdirSync(path.join(root, 'feature-AKIAFAKEFAKEFAKEFAKE'));
    fs.writeFileSync(path.join(root, 'feature-AKIAFAKEFAKEFAKEFAKE', 'build.gradle'), "plugins { id 'com.android.library' }\n");
    fs.writeFileSync(path.join(root, 'settings.gradle'), "include ':app'\ninclude ':feature-AKIAFAKEFAKEFAKEFAKE'\n");
    writeTo(root);
    const ai = path.join(root, '.ai');
    const rendered = readAll(ai).filter(([f]) => f.startsWith('knowledge/') || f === 'README.md');
    assert.ok(rendered.some(([, t]) => t.includes('[REDACTED:aws-access-key]')), 'secret-bearing module path should render redacted');
    for (const [f, text] of readAll(ai)) assert.ok(!text.includes('AKIAFAKEFAKEFAKEFAKE'), `secret leaked into ${f}`);
    JSON.parse(fs.readFileSync(path.join(ai, 'candidates.json'), 'utf8'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
