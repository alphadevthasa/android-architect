import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package has no install-time scripts', () => {
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare'])
    assert.equal(pkg.scripts?.[k], undefined);
});
test('package has no runtime or dev dependencies', () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), []);
});
test('package metadata', () => {
  assert.equal(pkg.name, 'android-architect');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.bin['android-architect'], 'bin/cli.js');
  assert.equal(pkg.engines.node, '>=20');
  assert.deepEqual([...pkg.files].sort(), ['bin', 'skill']);
});
test('network is blocked in tests', async () => {
  await assert.rejects(() => fetch('https://example.com'), /network disabled/);
});
