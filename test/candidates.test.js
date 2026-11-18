import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { detectStack } from '../skill/scripts/lib/detect.js';
import { candidatePaths } from '../skill/scripts/lib/candidates.js';

const catalog = loadCatalog();
const legacy = detectStack(new URL('./fixtures/legacy-java-mvp', import.meta.url).pathname, catalog);

test('candidates for legacy project', () => {
  const c = candidatePaths(legacy, catalog);
  assert.deepEqual(c.presentation.current, ['mvp']);
  assert.ok(c.presentation.next.includes('mvvm-livedata'));
  assert.ok(!c.presentation.next.includes('mvp'));
  assert.ok(c.presentation.reachable.includes('udf-stateflow'));
  assert.ok(c.ui.blockedBy.compose.some((p) => p.dimension === 'language' && p.anyOf.includes('kotlin')));
});

test('blockedBy covers every reachable entry with unmet prerequisites', () => {
  const c = candidatePaths(legacy, catalog);
  for (const dim of catalog.dimensions) {
    for (const id of c[dim.id].reachable) {
      const prereqs = catalog.entry(dim.id, id).prerequisites ?? [];
      const present = (d) => new Set((legacy.dimensions[d]?.entries ?? []).filter((e) => e.share === null || e.share > 0).map((e) => e.id));
      const unmet = prereqs.filter((p) => !p.anyOf.some((x) => present(p.dimension).has(x)));
      assert.equal(id in c[dim.id].blockedBy, unmet.length > 0, `${dim.id}.${id}`);
    }
  }
});

test('share null counts as present', () => {
  const profile = { dimensions: { language: { entries: [{ id: 'kotlin', share: null }] } } };
  const c = candidatePaths(profile, catalog);
  assert.deepEqual(c.language.current, ['kotlin']);
  assert.ok(!c.language.next.includes('kotlin'));
  assert.ok(!('compose' in c.ui.blockedBy));
});

test('current ordering: numbers desc, nulls after, ties by id', () => {
  const profile = { dimensions: { language: { entries: [
    { id: 'kmp', share: null }, { id: 'kotlin', share: null }, { id: 'java', share: 0.3 }, { id: 'java8-desugar', share: 0.7 },
  ] } } };
  assert.deepEqual(candidatePaths(profile, catalog).language.current, ['java8-desugar', 'java', 'kmp', 'kotlin']);
});
