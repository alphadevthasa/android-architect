import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(root, 'test/helpers/no-network.mjs');
const node = (args) => execFileSync(process.execPath, ['--import', helper, ...args], { encoding: 'utf8' });

test('npm pack contains the skill and CLI, excludes tests and docs', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  for (const f of ['bin/cli.js', 'skill/SKILL.md', 'skill/catalog/catalog.json', 'README.md', 'LICENSE'])
    assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('docs/')));
});

test('installed scan.js works on every fixture', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-e2e-'));
  try {
    node([path.join(root, 'bin/cli.js'), 'install', '--claude', '--home', home]);
    const scan = path.join(home, '.claude/skills/android-architect/scripts/scan.js');
    const fx = path.join(root, 'test/fixtures');
    // test/fixtures/workspace holds several repos; scan each repo rather than the container.
    const dirs = fs.readdirSync(fx).flatMap((d) =>
      d === 'workspace' ? fs.readdirSync(path.join(fx, d)).map((r) => `${d}/${r}`) : [d],
    );
    assert.ok(dirs.length >= 3);
    for (const d of dirs) {
      const profile = JSON.parse(node([scan, path.join(fx, d), '--format', 'json']));
      assert.equal(profile.schemaVersion, 1, d);
      assert.equal(typeof profile.dimensions, 'object', d);
      assert.ok(profile.dimensions !== null && !Array.isArray(profile.dimensions), d);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('README has required sections', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  for (const h of ['## Install', '## Usage', '## Supported setups', '## No telemetry'])
    assert.ok(readme.includes(h), h);
});

test('M7: installed copy runs scan --out, candidates and recommend-check end to end', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-e2e-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-e2e-work-'));
  try {
    node([path.join(root, 'bin/cli.js'), 'install', '--claude', '--home', home]);
    const scripts = path.join(home, '.claude/skills/android-architect/scripts');
    const project = path.join(root, 'test/fixtures/legacy-java-mvp');
    const profilePath = path.join(work, 'profile.json');
    assert.equal(node([path.join(scripts, 'scan.js'), project, '--format', 'json', '--out', profilePath]), '');
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const cand = JSON.parse(node([path.join(scripts, 'candidates.js'), project]));
    assert.deepEqual(cand.presentation.current, ['mvp']);
    assert.ok(cand.presentation.next.includes('mvvm-livedata'));
    const recs = {
      schemaVersion: 1,
      catalogVersion: profile.catalogVersion,
      generatedAt: '2026-11-19',
      dimensions: [
        { dimension: 'presentation', current: cand.presentation.current, target: 'mvvm-livedata', label: 'should', rationale: 'Presenters hold view references; ViewModel survives configuration changes.' },
        { dimension: 'language', current: cand.language.current, target: 'java8-desugar', label: 'must', rationale: 'Desugaring is the first step toward Kotlin interop.' },
      ],
      steps: [
        { id: 's1', dimension: 'language', from: 'java', to: 'java8-desugar', dependsOn: [] },
        { id: 's2', dimension: 'presentation', from: 'mvp', to: 'mvvm-livedata', dependsOn: ['s1'] },
      ],
    };
    const recPath = path.join(work, 'recommendations.json');
    fs.writeFileSync(recPath, JSON.stringify(recs));
    const r = spawnSync(process.execPath, ['--import', helper, path.join(scripts, 'recommend-check.js'), recPath, '--profile', profilePath], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, violations: [], warnings: [] });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('M2: installed init-ai.js, then the vendored ai-status.js reports ok', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-e2e-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-e2e-work-'));
  try {
    node([path.join(root, 'bin/cli.js'), 'install', '--claude', '--home', home]);
    const project = path.join(work, 'proj');
    fs.cpSync(path.join(root, 'test/fixtures/legacy-java-mvp'), project, { recursive: true });
    node([path.join(home, '.claude/skills/android-architect/scripts/init-ai.js'), project]);
    const manifest = JSON.parse(fs.readFileSync(path.join(project, '.ai/manifest.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.toolVersion, pkg.version);
    const status = JSON.parse(node([path.join(project, '.ai/tools/scripts/ai-status.js'), project]));
    assert.equal(status.ok, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});
