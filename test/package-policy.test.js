import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
test('npm pack ships no dev/, test/ or eval files', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname, timeout: 60000 });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  assert.ok(files.length > 0);
  assert.deepEqual(files.filter((p) => !(p.startsWith('bin/') || p.startsWith('skill/') || ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(p))), []);
  for (const p of files) assert.ok(!/^(dev|test|docs|\.superpowers)\//.test(p), p);
});
