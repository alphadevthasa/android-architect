import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { detectStack } from '../skill/scripts/lib/detect.js';
import { discoverModules } from '../skill/scripts/lib/modules.js';
import { listFiles } from '../skill/scripts/lib/walk.js';
import { generatedHeader, renderKnowledge, renderReadme } from '../skill/scripts/lib/knowledge.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'modern-compose');
const catalog = loadCatalog();
const profile = detectStack(root, catalog);
const modules = discoverModules(root, listFiles(root));
const meta = { date: '2026-11-19', commit: null, catalogVersion: '2026.11.0' };
const HEADER = '<!-- generated: 2026-11-19 @ no-git, catalog 2026.11.0. Do not edit: refresh overwrites this file. -->';

test('generatedHeader format', () => {
  assert.equal(generatedHeader(meta), HEADER);
  assert.match(generatedHeader({ ...meta, commit: 'abc1234' }), /@ abc1234,/);
});

test('every knowledge file starts with the header', () => {
  const out = renderKnowledge(profile, modules, catalog, meta);
  assert.deepEqual(Object.keys(out).sort(), [
    'knowledge/architecture-current.md',
    'knowledge/dependencies.md',
    'knowledge/feature-map.md',
    'knowledge/module-map.md',
    'knowledge/stack-profile.md',
  ]);
  for (const [k, v] of Object.entries(out)) assert.ok(v.startsWith(HEADER + '\n\n'), k);
  assert.ok(out['knowledge/stack-profile.md'].includes('# Android stack profile'));
  assert.ok(out['knowledge/feature-map.md'].includes('TODO: feature scores arrive with the "prioritize" command in a later version.'));
});

test('module-map has mermaid graph and every module', () => {
  const md = renderKnowledge(profile, modules, catalog, meta)['knowledge/module-map.md'];
  assert.ok(md.includes('graph TD'));
  for (const m of modules) assert.ok(md.includes(m.path), m.path);
  assert.match(md, /m_app --> m_feature_home/);
});

test('dependencies lists fixture coordinates and project deps separately', () => {
  const md = renderKnowledge(profile, modules, catalog, meta)['knowledge/dependencies.md'];
  assert.ok(md.includes('androidx.navigation:navigation-compose | 2.8.4'));
  assert.ok(md.includes('project(:feature:home)'));
});

test('architecture-current has dimensions, modules and sdk', () => {
  const md = renderKnowledge(profile, modules, catalog, meta)['knowledge/architecture-current.md'];
  assert.match(md, /- Modules: \d+/);
  assert.match(md, /- SDK: min/);
  assert.match(md, /\(\w[\w-]*\): (\d+%|<1%|present)/);
});

test('renderReadme fills placeholders and rejects missing or unknown', () => {
  const v = { toolVersion: '1.2.3', catalogVersion: '2026.11.0', date: '2026-11-19', commit: null, mode: 'shared', workspace: null };
  const md = renderReadme(v);
  assert.ok(md.includes('1.2.3') && md.includes('no-git') && !md.includes('{{'));
  assert.throws(() => renderReadme({ ...v, toolVersion: undefined }), /toolVersion/);
  assert.throws(() => renderReadme(v, path.join(root, '..', 'no-such-dir')));
});
