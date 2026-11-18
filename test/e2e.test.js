import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
    const dirs = fs.readdirSync(fx);
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
