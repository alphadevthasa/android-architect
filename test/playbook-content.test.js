import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { loadPlaybooks, validatePlaybooks, applyPlaybook } from '../skill/scripts/lib/playbooks.js';
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
  'rxjava3--to--coroutines-flow': ['error handler', 'token', 'thread'],
  'rxjava2--to--coroutines-flow': ['error handler', 'token', 'undeliverable'],
  'asynctask-loader--to--coroutines-flow': ['workmanager', 'service', 'upload'],
  'coroutines-livedata--to--coroutines-flow': ['retain', 'log'],
  'dagger2--to--hilt': ['scope', 'credential'],
  'koin--to--hilt': ['scope', 'credential'],
  'xml-layouts--to--compose': ['flag_secure', 'webview', 'accessibility', 'password'],
  'jetpack-nav-xml--to--nav-compose-typesafe': ['exported', 'intent filter', 'validat'],
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

const BATCH_B = ['rxjava3--to--coroutines-flow', 'rxjava2--to--coroutines-flow', 'asynctask-loader--to--coroutines-flow', 'coroutines-livedata--to--coroutines-flow',
  'dagger2--to--hilt', 'koin--to--hilt', 'xml-layouts--to--compose', 'jetpack-nav-xml--to--nav-compose-typesafe'];

test('async, DI, UI and navigation playbooks: ids, dimension, flags and checklist size', () => {
  const dims = { 'rxjava3--to--coroutines-flow': 'async', 'rxjava2--to--coroutines-flow': 'async', 'asynctask-loader--to--coroutines-flow': 'async',
    'coroutines-livedata--to--coroutines-flow': 'async', 'dagger2--to--hilt': 'di', 'koin--to--hilt': 'di',
    'xml-layouts--to--compose': 'ui', 'jetpack-nav-xml--to--nav-compose-typesafe': 'navigation' };
  for (const id of BATCH_B) {
    const p = byId.get(id);
    assert.ok(p, `missing ${id}`);
    assert.equal(p.dimension, dims[id]);
    assert.equal(p.irreversible, false, id);
    assert.equal(p.asOf, '2026-11-20');
    assert.ok(p.securityChecklist.length >= 2, id);
    assert.ok(p.sections.Steps.toLowerCase().includes('delete'), `${id}: no delete-last step`);
  }
});

test('Koin to Hilt: worthIf absent:kmp and When not to explains staying on Koin', () => {
  const p = byId.get('koin--to--hilt');
  assert.deepEqual(p.worthIf, ['absent:kmp']);
  assert.match(p.sections['When not to'], /Koin/);
  assert.match(p.sections['When not to'], /stay/i);
});

test('batch B specifics', () => {
  const rx = byId.get('rxjava3--to--coroutines-flow');
  assert.match(rx.sections.Steps, /kotlinx-coroutines-rx3/);
  const rxText = fs.readFileSync(path.join(DIR, 'rxjava3--to--coroutines-flow.md'), 'utf8');
  assert.doesNotMatch(rxText, /RxJava 2 projects follow the same steps/);
  assert.match(rxText, /RxJava 2 playbook/);
  assert.match(rxText, /UndeliverableException/);
  assert.match(rxText, /RxJava remains[^\n]*runtime dependency tree/);
  const rx2 = fs.readFileSync(path.join(DIR, 'rxjava2--to--coroutines-flow.md'), 'utf8');
  assert.match(rx2, /kotlinx-coroutines-rx2/);
  assert.match(rx2, /RxJava 3 playbook/);
  assert.match(rx2, /UndeliverableException/);
  assert.match(byId.get('rxjava2--to--coroutines-flow').sections['Security checklist'], /runtime dependency tree/);
  assert.match(byId.get('asynctask-loader--to--coroutines-flow').sections.Steps, /lifecycleScope|viewModelScope/);
  const lv = byId.get('coroutines-livedata--to--coroutines-flow');
  assert.match(lv.sections.Steps, /repeatOnLifecycle/);
  assert.match(lv.sections.Steps, /collectAsStateWithLifecycle|StateFlow/);
  const dg = byId.get('dagger2--to--hilt');
  assert.match(dg.sections.Steps, /@EntryPoint/);
  assert.match(dg.sections.Steps, /@InstallIn/);
  const ui = byId.get('xml-layouts--to--compose');
  assert.match(ui.sections.Steps, /ComposeView/);
  assert.match(ui.sections.Steps, /AndroidView/);
  assert.match(ui.sections['Security checklist'], /FLAG_SECURE/);
  assert.match(ui.sections['Security checklist'], /securePolicy/);
  assert.match(ui.sections['Security checklist'], /SecureOn/);
  const nav = byId.get('jetpack-nav-xml--to--nav-compose-typesafe');
  assert.match(nav.sections['Security checklist'], /exported/);
  assert.match(nav.sections.Steps, /kotlinx\.serialization/);
});

// Splits the numbered steps of a Steps section into one string per step.
const numberedSteps = (steps) => steps.split(/^(?=\d+\. )/m).filter((x) => /^\d+\. /.test(x));
const DELETES = /\b(delet|remov)\w*/i;
// Legitimate wording that only says when something is deleted later.
const LATER = /\b(is |are )?(removed|deleted|kept) (only )?(in|until) (step \d+|the last step)/gi;
const mentionsDelete = (text) => DELETES.test(text.replace(LATER, ''));

test('batch B ordering: seam first, side by side before per-unit cutover, deletion of the old implementation only after it', () => {
  for (const id of BATCH_B) {
    const steps = byId.get(id).sections.Steps;
    const at = (re) => steps.search(re);
    assert.ok(at(/seam/i) >= 0 && at(/side by side/i) > at(/seam/i), `${id}: seam then side by side`);
    assert.ok(at(/cutover/i) > at(/side by side/i), `${id}: cutover after side by side`);
    const list = numberedSteps(steps);
    const cut = list.findIndex((x) => /cutover/i.test(x));
    assert.ok(cut >= 0, `${id}: no cutover step`);
    const firstDelete = list.findIndex((x) => mentionsDelete(x));
    assert.ok(firstDelete > cut, `${id}: step ${firstDelete + 1} deletes or removes at or before the cutover step ${cut + 1}`);
    assert.ok(/\bdelet/i.test(list[list.length - 1]), `${id}: the final step deletes the old implementation`);
    assert.ok(list.length - 1 > cut, `${id}: deletion step is after the cutover step`);
  }
  assert.match(byId.get('rxjava3--to--coroutines-flow').sections.Steps, /persist/i);
  assert.match(byId.get('coroutines-livedata--to--coroutines-flow').sections.Steps, /persist|SavedStateHandle/);
});

test('Dagger and Koin: single owner for stateful bindings, old graph kept until the last step', () => {
  for (const id of ['dagger2--to--hilt', 'koin--to--hilt']) {
    const steps = byId.get(id).sections.Steps;
    assert.match(steps, /exactly one owner|one owner/i, id);
    assert.match(steps, /two instances/i, id);
    assert.match(byId.get(id).sections.Rollback, /until the last unit has shipped/, id);
  }
});

test('Koin to Hilt: worth is false when kmp is present and true without it', () => {
  const koin = byId.get('koin--to--hilt');
  const mk = (extra) => ({ modules: [{ path: ':', dir: '' }], dimensions: { di: { entries: [{ id: 'koin', share: 1, units: 1, evidence: [] }] }, ...extra } });
  const kmp = applyPlaybook(koin, mk({ kmp: { entries: [{ id: 'kmp', share: null, units: 0, evidence: [] }] } }), catalog, { matches: [] });
  assert.equal(kmp.worth.ok, false);
  assert.equal(applyPlaybook(koin, mk({}), catalog, { matches: [] }).worth.ok, true);
  assert.match(catalog.entry('di', 'koin').notes, /lateral/i);
});

test('Rollback step references point to existing steps (all playbooks)', () => {
  for (const p of playbooks) {
    const count = numberedSteps(p.sections.Steps).length;
    for (const m of p.sections.Rollback.matchAll(/\bstep (\d+)\b/gi)) {
      const n = Number(m[1]);
      assert.ok(n >= 1 && n <= count, `${p.id}: Rollback references step ${n} but there are ${count}`);
    }
  }
  // The referenced step must be the one that does what Rollback says.
  for (const id of BATCH_B) {
    const list = numberedSteps(byId.get(id).sections.Steps);
    for (const m of byId.get(id).sections.Rollback.matchAll(/After step (\d+) (?:deletes|removes)/g)) {
      assert.match(list[Number(m[1]) - 1], /^\d+\. (Delete|When every unit has moved|When the last graph has moved)/, `${id}: step ${m[1]} is not the deletion step`);
    }
  }
});

test('Dagger: stateful modules are installed in the owner graph only, with a dedicated ownership handover before deletion', () => {
  const steps = byId.get('dagger2--to--hilt').sections.Steps;
  assert.match(steps, /owner graph only/);
  assert.match(steps, /Hand over ownership[^\n]*before the old component is deleted/);
  assert.ok(steps.search(/Hand over ownership/) < steps.search(/per-unit cutover/));
  assert.match(byId.get('dagger2--to--hilt').sections.Rollback, /revert that release as a whole/);
});

test('Koin rollback goes back to Koin lookups and never repoints a bridge', () => {
  const r = byId.get('koin--to--hilt').sections.Rollback;
  assert.match(r, /by inject\(\)/);
  assert.match(r, /single owner of each stateful type never changes/);
  assert.doesNotMatch(r + byId.get('koin--to--hilt').sections.Steps, /\bthe flag\b/);
});
