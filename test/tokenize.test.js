import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../skill/scripts/lib/tokenize.js';

test('splits camelCase and digit boundaries, keeps the whole identifier', () => {
  assert.deepEqual(
    tokenize('RetrofitClient.getUser2FA()').sort(),
    ['2fa', 'client', 'get', 'getuser2fa', 'retrofit', 'retrofitclient', 'user'].sort(),
  );
});

test('drops stopwords', () => {
  assert.deepEqual(tokenize('the of a'), []);
});

test('drops tokens longer than 40 characters', () => {
  assert.ok(!tokenize('x'.repeat(41)).length);
});
