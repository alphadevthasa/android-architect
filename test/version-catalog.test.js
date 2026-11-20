import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersionCatalog, resolveAlias, resolveBundle } from '../skill/scripts/lib/version-catalog.js';

const TOML = `
# comment
[versions]
retrofit = "2.9.0"
kotlin = "1.9.22" # trailing

[libraries]
okhttp = "com.squareup.okhttp3:okhttp:4.12.0"
retrofit_core = { module = "com.squareup.retrofit2:retrofit", version.ref = "retrofit" }
coil = { group = "io.coil-kt", name = "coil", version = "2.5.0" }
timber = { module = "com.jakewharton.timber:timber" }
ghost = { module = "a:b", version.ref = "missing" }
strict = { module = "a:s", version = { strictly = "1.0" } }
reffed = { module = "a:r", version = { ref = "kotlin" } }
prefer = { module = "a:p", version = { prefer = "3.0" } }
broken line here
multi = [
  "x",
]

[bundles]
net = ["okhttp", "retrofit-core"]

[plugins]
hilt = { id = "com.google.dagger.hilt.android", version.ref = "kotlin" }
`;

test('parses versions, libraries, plugins', () => {
  const vc = parseVersionCatalog(TOML);
  assert.equal(vc.versions.retrofit, '2.9.0');
  assert.equal(vc.versions.kotlin, '1.9.22');
  assert.deepEqual(vc.libraries.okhttp, { group: 'com.squareup.okhttp3', name: 'okhttp', version: '4.12.0' });
  assert.deepEqual(vc.libraries['retrofit-core'], { group: 'com.squareup.retrofit2', name: 'retrofit', version: '2.9.0' });
  assert.deepEqual(vc.libraries.coil, { group: 'io.coil-kt', name: 'coil', version: '2.5.0' });
  assert.equal(vc.libraries.timber.version, null);
  assert.equal(vc.libraries.ghost.version, null);
  assert.equal(vc.libraries.strict.version, '1.0');
  assert.equal(vc.libraries.reffed.version, '1.9.22');
  assert.equal(vc.libraries.prefer.version, '3.0');
  assert.deepEqual(vc.plugins.hilt, { id: 'com.google.dagger.hilt.android', version: '1.9.22' });
  assert.deepEqual(vc.bundles, { net: ['okhttp', 'retrofit-core'] });
  assert.equal(vc.libraries.net, undefined);
});

test('resolveAlias', () => {
  const vc = parseVersionCatalog(TOML);
  assert.deepEqual(resolveAlias(vc, 'libs.retrofit.core'), {
    kind: 'library', group: 'com.squareup.retrofit2', name: 'retrofit', version: '2.9.0', alias: 'retrofit-core',
  });
  assert.deepEqual(resolveAlias(vc, 'libs.plugins.hilt'), {
    kind: 'plugin', id: 'com.google.dagger.hilt.android', version: '1.9.22', alias: 'hilt',
  });
  assert.equal(resolveAlias(vc, 'libs.nope'), null);
  assert.equal(resolveAlias(vc, 'libs.versions.kotlin'), null);
  assert.equal(resolveAlias(vc, 'libs.bundles.net'), null);
  assert.equal(resolveAlias(vc, 'other.okhttp'), null);
});

test('never throws on garbage', () => {
  assert.doesNotThrow(() => parseVersionCatalog('[libraries\nx = {\n= =\n"'));
  assert.doesNotThrow(() => parseVersionCatalog(undefined));
});

test('brackets inside quoted strings do not break parsing', () => {
  const vc = parseVersionCatalog(`[libraries]
a = { module = "x:a", version = { strictly = "[1.0,2.0)" } }
c = { module = "x:c", version = { prefer = "[1.+,)" } }
b = "x:b:1"

[plugins]
p = { id = "pl.p", version = "2" }
`);
  assert.equal(vc.libraries.a.version, '[1.0,2.0)');
  assert.equal(vc.libraries.c.version, '[1.+,)');
  assert.equal(vc.libraries.b.version, '1');
  assert.deepEqual(vc.plugins.p, { id: 'pl.p', version: '2' });
});

test('prototype keys are not resolved', () => {
  const vc = parseVersionCatalog(`[libraries]
x = { module = "g:n", version.ref = "constructor" }
`);
  assert.equal(vc.libraries.x.version, null);
  assert.equal(resolveAlias(vc, 'libs.constructor'), null);
  assert.equal(resolveAlias(vc, 'libs.plugins.toString'), null);
});

test('single-quoted literal strings are string-aware', () => {
  const vc = parseVersionCatalog(`[libraries]
a = { module = 'x:a', version = { strictly = '[1.0,2.0)' } }
'q' = "x:q:3"
y = 'a:b#c'
b = "x:b:1"
`);
  assert.equal(vc.libraries.a.version, '[1.0,2.0)');
  assert.equal(vc.libraries.q.version, '3');
  assert.deepEqual(vc.libraries.y, { group: 'a', name: 'b#c', version: null });
  assert.equal(vc.libraries.b.version, '1');
});

test('resolveBundle expands bundles (one line or several) into libraries', () => {
  const vc = parseVersionCatalog(TOML + '\n[bundles]\nwide = [\n  "okhttp", # c\n  "ghost-x",\n]\n');
  const net = resolveBundle(vc, 'libs.bundles.net');
  assert.equal(net.complete, true);
  assert.deepEqual(net.members.map((m) => `${m.group}:${m.name}:${m.version}`), ['com.squareup.okhttp3:okhttp:4.12.0', 'com.squareup.retrofit2:retrofit:2.9.0']);
  const wide = resolveBundle(vc, 'libs.bundles.wide');
  assert.equal(wide.complete, false);
  assert.deepEqual(wide.members.map((m) => m.alias), ['okhttp']);
  assert.equal(resolveBundle(vc, 'libs.bundles.nope'), null);
  assert.equal(resolveBundle(vc, 'libs.okhttp'), null);
});
