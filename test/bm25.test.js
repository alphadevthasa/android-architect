import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBm25, scoreBm25 } from '../skill/scripts/lib/bm25.js';

const m = buildBm25([
  { id: 'a', tokens: ['room', 'dao'] },
  { id: 'b', tokens: ['retrofit', 'api', 'api'] },
]);

test('scores only matching docs', () => {
  assert.deepEqual(scoreBm25(m, ['api']).map((r) => r.id), ['b']);
  assert.deepEqual(scoreBm25(m, ['nothing']), []);
});

test('model carries avgdl, df and per-doc tf', () => {
  assert.equal(m.avgdl, 2.5);
  assert.equal(m.df.api, 1);
  assert.deepEqual(m.docs[1], { id: 'b', len: 3, tf: { retrofit: 1, api: 2 } });
});

test('ties sort by id ascending', () => {
  const t = buildBm25([{ id: 'z', tokens: ['x1'] }, { id: 'a', tokens: ['x1'] }]);
  assert.deepEqual(scoreBm25(t, ['x1']).map((r) => r.id), ['a', 'z']);
});

test('prototype-named terms are ordinary terms', () => {
  const words = ['constructor', 'tostring', 'hasownproperty', 'valueof'];
  const pm = buildBm25([
    { id: 'a', tokens: ['constructor', 'injection'] },
    { id: 'b', tokens: ['room'] },
  ]);
  assert.equal(pm.df.constructor, 1);
  assert.deepEqual(scoreBm25(pm, ['constructor', 'injection']).map((r) => r.id), ['a']);
  for (const w of words) assert.deepEqual(scoreBm25(pm, [w]).map((r) => r.id), w === 'constructor' ? ['a'] : []);
  // survives a JSON round trip (as in a loaded index)
  const loaded = JSON.parse(JSON.stringify(pm));
  assert.deepEqual(scoreBm25(loaded, ['constructor']).map((r) => r.id), ['a']);
  assert.deepEqual(scoreBm25(loaded, ['valueof', 'room']).map((r) => r.id), ['b']);
});
