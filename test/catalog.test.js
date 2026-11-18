import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, validateCatalog, CatalogError, SUPPORTED_SCHEMA_VERSION } from '../skill/scripts/lib/catalog.js';

const meta = { schemaVersion: 1, catalogVersion: 'x', asOf: '2026-11-19', dimensions: ['d'] };
const entry = (id, extra = {}) => ({
  id, name: id, era: 1, status: 'current', successors: [], detect: { files: ['a'] }, ...extra,
});
const raw = (entries, m = meta, more = []) => ({ meta: m, dimensions: [{ id: 'd', name: 'D', entries }, ...more] });

test('loads shipped catalog', () => {
  const c = loadCatalog();
  assert.equal(c.catalogVersion, '2026.11.0');
  const ids = c.dimensions.map((d) => d.id);
  for (const id of ['language', 'build', 'ui']) assert.ok(ids.includes(id));
  assert.equal(c.entry('language', 'kotlin').id, 'kotlin');
  assert.equal(c.entry('language', 'nope'), undefined);
  assert.equal(SUPPORTED_SCHEMA_VERSION, 1);
});

test('rejects unknown schemaVersion', () => {
  const errs = validateCatalog(raw([entry('a')], { ...meta, schemaVersion: 2 }));
  assert.ok(errs.some((e) => /schemaVersion/.test(e)));
});

test('rejects successor pointing to unknown id', () => {
  const errs = validateCatalog(raw([entry('a', { successors: ['zzz'] })]));
  assert.ok(errs.some((e) => e.includes('unknown successor "zzz"')));
});

test('rejects duplicate entry ids', () => {
  const errs = validateCatalog(raw([entry('a'), entry('a')]));
  assert.ok(errs.some((e) => e.includes('duplicate entry id "a"')));
});

test('rejects entry without detect signals', () => {
  const errs = validateCatalog(raw([entry('a', { detect: {} })]));
  assert.ok(errs.some((e) => e.includes('no detect signals')));
  const errs2 = validateCatalog(raw([entry('a', { detect: { files: [] } })]));
  assert.ok(errs2.some((e) => e.includes('no detect signals')));
});

test('rejects successor cycle', () => {
  const errs = validateCatalog(raw([entry('a', { successors: ['b'] }), entry('b', { successors: ['a'] })]));
  assert.ok(errs.some((e) => e.includes('successor cycle')));
});

test('rejects prerequisite to unknown dimension/entry', () => {
  const e1 = validateCatalog(raw([entry('a', { prerequisites: [{ dimension: 'nope', anyOf: ['x'] }] })]));
  assert.ok(e1.some((e) => e.includes('unknown dimension "nope"')));
  const e2 = validateCatalog(raw([entry('a', { prerequisites: [{ dimension: 'd', anyOf: ['x'] }] })]));
  assert.ok(e2.some((e) => e.includes('unknown entry "x"')));
});

test('rejects bad status', () => {
  const errs = validateCatalog(raw([entry('a', { status: 'old' })]));
  assert.ok(errs.some((e) => e.includes('bad status "old"')));
});

test('accepts computed detect and policy', () => {
  assert.deepEqual(validateCatalog(raw([entry('a', { detect: { computed: true }, policy: { x: 1 } })])), []);
});

test('loadCatalog throws CatalogError listing errors', () => {
  assert.throws(() => loadCatalog(new URL('./nonexistent-dir/', import.meta.url)), CatalogError);
});

test('every shipped entry validates', () => {
  const c = loadCatalog();
  for (const d of c.dimensions) for (const e of d.entries) {
    assert.ok(Number.isInteger(e.era) && e.era >= 1, `${d.id}.${e.id} era`);
    assert.ok(Array.isArray(e.successors));
  }
});

test('shipped successor and prerequisite rulings', () => {
  const c = loadCatalog();
  assert.deepEqual(c.entry('ui', 'databinding').successors, ['viewbinding', 'compose']);
  assert.deepEqual(c.entry('build', 'kapt').successors, ['ksp']);
  assert.deepEqual(c.entry('language', 'kotlin-k2').detect, { computed: true });
});
