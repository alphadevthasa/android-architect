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
  assert.ok(out['knowledge/feature-map.md'].includes('# Feature map'));
  assert.ok(!out['knowledge/feature-map.md'].includes('TODO'));
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

test('compliance sections: gap only under gaps, check and unknown under manual check, ok omitted', () => {
  const ids = catalog.dimensions.find((d) => d.id === 'compliance')?.entries.map((e) => e.id) ?? ['a', 'b', 'c'];
  const p = { ...profile, compliance: [
    { id: ids[0] ?? 'a', status: 'ok', detail: 'DETAIL_OK' },
    { id: 'x-gap', status: 'gap', detail: 'DETAIL_GAP' },
    { id: 'x-unk', status: 'unknown', detail: 'DETAIL_UNK' },
    { id: 'x-chk', status: 'check', detail: 'DETAIL_CHK\n## Forged', source: 'https://developer.android.com/x' },
  ], buildPerformance: { items: [{ id: 'org.gradle.caching', status: 'gap', detail: 'PERF_DETAIL', file: 'gradle.properties', line: null }] } };
  const md = renderKnowledge(p, modules, catalog, meta)['knowledge/architecture-current.md'];
  const gapSec = md.slice(md.indexOf('## Compliance gaps'), md.indexOf('## Compliance needs manual check'));
  const unkSec = md.slice(md.indexOf('## Compliance needs manual check'), md.indexOf('## Build performance checks'));
  assert.ok(gapSec.includes('DETAIL_GAP') && !gapSec.includes('DETAIL_UNK') && !gapSec.includes('DETAIL_CHK'));
  assert.ok(unkSec.includes('DETAIL_UNK') && unkSec.includes('DETAIL_CHK') && !unkSec.includes('DETAIL_GAP'));
  assert.ok(!md.includes('\n## Forged'));
  assert.match(md, /## Build performance checks\n\n- org\.gradle\.caching: gap \(PERF_DETAIL\) \[gradle\.properties\]/);
  assert.ok(!md.includes('DETAIL_OK'));
});

test('hostile file and module names cannot forge Markdown structure in generated knowledge or scan --format md', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-hostile-md-'));
  try {
    fs.cpSync(root, dir, { recursive: true });
    const bidi = String.fromCharCode(0x202e);
    const evil = `A\n## Next steps\n[x](http:\\evil)${bidi}`;
    const pkgDir = path.join(dir, 'feature/home/src/main/kotlin/com/example/modern/feature/home');
    fs.copyFileSync(path.join(pkgDir, 'HomeViewModel.kt'), path.join(pkgDir, `${evil}.kt`));
    fs.copyFileSync(path.join(pkgDir, 'HomeScreen.kt'), path.join(pkgDir, `${evil}Screen.kt`));
    const settings = path.join(dir, 'settings.gradle.kts');
    fs.appendFileSync(settings, `include(":evil\n## Forged module\n[y]: http://evil${bidi}")\n`);
    fs.appendFileSync(path.join(dir, 'app/build.gradle.kts'), `\ndependencies {\n    implementation(project(":evil\n## Forged dep"))\n}\n`);
    const p = detectStack(dir, catalog);
    const mods = discoverModules(dir, listFiles(dir));
    assert.ok(mods.some((m) => m.path.includes('Forged module')), 'fixture really has a hostile module path');
    const out = renderKnowledge(p, mods, catalog, meta);
    const scan = spawnSync(process.execPath, [path.resolve('skill/scripts/scan.js'), dir, '--format', 'md'], { encoding: 'utf8' });
    assert.equal(scan.status, 0, scan.stderr);
    const texts = { ...out, 'scan.md': scan.stdout };
    assert.ok(Object.values(texts).some((t) => t.includes('Next steps')), 'hostile evidence path is shown somewhere');
    for (const [name, text] of Object.entries(texts)) {
      for (const line of text.split('\n')) {
        assert.ok(!/^\s*(?:#+ )?(?:Next steps|Forged|\[[xy]\])/.test(line), `${name}: forged line ${JSON.stringify(line)}`);
      }
      assert.ok(!text.includes('[x](') && !/(^|[^\\])\[y\]/.test(text), `${name}: unescaped link`);
      assert.ok(!text.includes(bidi), `${name}: bidi control`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
