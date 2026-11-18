import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles } from '../skill/scripts/lib/walk.js';
import { parseSettings, discoverModules, moduleGraph } from '../skill/scripts/lib/modules.js';

const fx = (n) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', n);
const load = (n) => discoverModules(fx(n), listFiles(fx(n)));

test('parseSettings handles groovy and kts includes', () => {
  const s = parseSettings("include ':a', ':b:c'\ninclude(\":d\")\nproject(':a').projectDir = file('x/a')", 'groovy');
  assert.deepEqual(s.includes, [':a', ':b:c', ':d']);
  assert.deepEqual(s.projectDirs, { ':a': 'x/a' });
});

test('multi-include line', () => {
  const mods = load('modern-compose');
  assert.deepEqual(mods.map((m) => m.path), [':app', ':core:data', ':feature:home']);
  assert.equal(mods.find((m) => m.path === ':core:data').dir, 'core/data');
});

test('projectDir override', () => {
  assert.equal(load('mixed').find((m) => m.path === ':legacy').dir, 'libs/legacy');
});

test('no settings = single root module', () => {
  assert.deepEqual(load('single-module-no-settings').map((m) => m.path), [':']);
});

test('project deps become edges', () => {
  const g = moduleGraph(load('modern-compose'));
  assert.deepEqual(g.nodes, [':app', ':core:data', ':feature:home']);
  assert.ok(g.edges.some(([a, b]) => a === ':app' && b === ':feature:home'));
  assert.ok(g.edges.some(([a, b]) => a === ':feature:home' && b === ':core:data'));
});

test('root ext feeds module parse', () => {
  const app = load('legacy-java-mvp').find((m) => m.path === ':app');
  const retrofit = app.build.dependencies.find((d) => d.name === 'retrofit');
  assert.equal(retrofit.version, '2.3.0');
});

test('version catalog feeds module parse', () => {
  const app = load('modern-compose').find((m) => m.path === ':app');
  assert.ok(app.build.plugins.some((p) => p.id === 'com.google.dagger.hilt.android'));
  const nav = app.build.dependencies.find((d) => d.name === 'navigation-compose');
  assert.equal(nav.version, '2.8.4');
  assert.equal(app.build.android.targetSdk, 35);
});
