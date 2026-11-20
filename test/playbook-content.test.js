import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { loadPlaybooks, validatePlaybooks } from '../skill/scripts/lib/playbooks.js';
import { scanInstructions } from '../skill/scripts/lib/injection.js';
import { redact } from '../skill/scripts/lib/redact.js';

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

// Optional denylist of private or employer names, supplied by the maintainer's environment (comma-separated,
// case-insensitive). No names are stored in the repository; the check is skipped when the variable is unset.
const PRIVATE_NAMES = (process.env.ANDROID_ARCHITECT_PRIVATE_NAMES ?? '')
  .split(',').map((n) => n.trim().toLowerCase()).filter((n) => n !== '');

test('no secret shapes in any playbook, and no private names when a denylist is configured', () => {
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.equal(redact(text).text, text, `${f}: redact() changed the text`);
    assert.deepEqual(redact(text).hits, [], `${f}: secret shape found`);
    const lower = text.toLowerCase();
    for (const name of PRIVATE_NAMES) assert.ok(!lower.includes(name), `${f}: contains a denylisted name`);
  }
});

test('irreversible playbooks state the safe ordering: backup, single writer, no destructive fallback', () => {
  for (const p of playbooks.filter((x) => x.irreversible)) {
    const steps = p.sections.Steps.toLowerCase();
    assert.ok(steps.includes('safe ordering'), `${p.id}: Steps lacks the safe ordering`);
    assert.ok(/single writer|one writer|no dual-write|one-way per file/.test(steps), `${p.id}: no single-writer rule`);
  }
  for (const id of ['sqliteopenhelper--to--room', 'room--to--sqldelight']) {
    const p = byId.get(id);
    assert.match(p.sections.Steps, /wal_checkpoint/);
    assert.match(p.sections.Rollback, /fallbackToDestructiveMigration/);
  }
  assert.match(byId.get('sqliteopenhelper--to--room').sections.Steps, /onDowngrade/);
});

test('sqldelight is a KMP-gated catalog target', () => {
  const e = catalog.entry('persistence', 'sqldelight');
  assert.deepEqual(e.prerequisites, [{ dimension: 'language', anyOf: ['kmp'] }]);
});

test('object-database copies switch every read and write at the marker; sqldelight keeps the rollback flag to the last step', () => {
  for (const id of ['greendao--to--room', 'ormlite--to--room', 'realm--to--room']) {
    const steps = byId.get(id).sections.Steps;
    assert.match(steps, /all at once/, id);
    assert.match(steps, /read-only/, id);
    assert.match(steps, /write gate/, id);
  }
  const sd = byId.get('room--to--sqldelight');
  assert.match(sd.sections.Steps, /8\.[^\n]*ends the flag-flip window/);
  assert.match(sd.sections.Steps, /9\.[^\n]*no longer created[^\n]*never two connection owners/);
  assert.match(sd.sections.Steps, /10\. Step 10 deletes dead code only/);
  assert.match(sd.sections.Rollback, /three windows/i);
  assert.match(sd.sections.Rollback, /never use `fallbackToDestructiveMigration`/i);
});
