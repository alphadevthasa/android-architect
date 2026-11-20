import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { loadPlaybooks, validatePlaybooks } from '../skill/scripts/lib/playbooks.js';
import { scanInstructions } from '../skill/scripts/lib/injection.js';

const DIR = path.resolve('skill/catalog/playbooks');
const catalog = loadCatalog();
const playbooks = loadPlaybooks(DIR);
const byId = new Map(playbooks.map((p) => [p.id, p]));

// id -> [keyword that must appear in Security checklist (lowercase)]
const EXPECT = {
  'okhttp-retrofit--to--ktor-client': ['pinning', 'cleartext', 'redact'],
  'sqliteopenhelper--to--room': ['sqlcipher', 'contentprovider', 'plaintext'],
  'greendao--to--room': ['encrypt', 'key', 'wipe'],
  'ormlite--to--room': ['encrypt', 'key', 'wipe'],
  'realm--to--room': ['encrypt', 'key', 'wipe'],
  'sharedpreferences--to--datastore': ['delete', 'backup'],
  'encrypted-sharedpreferences--to--datastore': ['not encrypted', 'tink', 'keystore'],
  'gson--to--moshi': ['allow list', 'size limit'],
  'gson--to--kotlinx-serialization': ['allow list', 'size limit'],
  'room--to--sqldelight': ['driver', 'encryption'],
};

test('shipped playbooks load and validate against the shipped catalog', () => {
  assert.deepEqual(validatePlaybooks(playbooks, catalog), []);
});

test('the expected ids exist', () => {
  for (const id of Object.keys(EXPECT)) assert.ok(byId.has(id), `missing ${id}`);
  assert.equal(playbooks.length, Object.keys(EXPECT).length);
});

for (const [id, words] of Object.entries(EXPECT)) {
  test(`${id}: security checklist, steps, asOf and verified`, () => {
    const p = byId.get(id);
    assert.ok(p.securityChecklist.length >= 2);
    const sec = p.sections['Security checklist'].toLowerCase();
    for (const w of words) assert.ok(sec.includes(w), `${id}: security checklist lacks "${w}"`);
    const steps = p.sections.Steps.toLowerCase();
    assert.ok(steps.includes('seam') && steps.includes('side by side'));
    assert.match(p.asOf, /^2026-11/);
    assert.equal(p.verified, false);
  });
}

test('flags: irreversible, kmpOnly and worthIf as specified', () => {
  assert.equal(byId.get('okhttp-retrofit--to--ktor-client').irreversible, false);
  assert.deepEqual(byId.get('okhttp-retrofit--to--ktor-client').worthIf, ['present:kmp']);
  for (const id of ['sqliteopenhelper--to--room', 'greendao--to--room', 'ormlite--to--room', 'realm--to--room',
    'sharedpreferences--to--datastore', 'encrypted-sharedpreferences--to--datastore']) {
    assert.equal(byId.get(id).irreversible, true, id);
  }
  const sd = byId.get('room--to--sqldelight');
  assert.equal(sd.kmpOnly, true);
  assert.deepEqual(sd.worthIf, ['present:kmp']);
});

test('Room playbook names MigrationTestHelper in Tests; Ktor and DataStore specifics', () => {
  assert.match(byId.get('sqliteopenhelper--to--room').sections.Tests, /MigrationTestHelper/);
  assert.match(byId.get('sharedpreferences--to--datastore').sections.Steps, /SharedPreferencesMigration/);
  assert.match(byId.get('gson--to--moshi').sections.Tests, /recorded JSON/i);
});

test('only the allowed documentation links appear', () => {
  const ok = ['https://developer.android.com', 'https://kotlinlang.org', 'https://ktor.io', 'https://square.github.io'];
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const raw of text.match(/https?:\/\/[^\s)>\]]+/g) ?? []) {
      const url = raw.replace(/[.,;:]+$/, '');
      assert.ok(ok.some((h) => url === h || url.startsWith(`${h}/`)), `${f}: ${url}`);
    }
  }
});

test('playbooks pass the injection scanner with zero findings', () => {
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.md'))) {
    assert.deepEqual(scanInstructions(fs.readFileSync(path.join(DIR, f), 'utf8')), [], f);
  }
});
