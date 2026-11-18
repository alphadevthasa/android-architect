import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(root, 'test/helpers/no-network.mjs');
const cli = path.join(root, 'bin/cli.js');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const run = (args) => spawnSync(process.execPath, ['--import', helper, cli, ...args], { encoding: 'utf8' });
const ok = (args) => execFileSync(process.execPath, ['--import', helper, cli, ...args], { encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cli-'));

test('install to existing harnesses only', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude'));
  ok(['install', '--home', home]);
  const t = path.join(home, '.claude/skills/android-architect');
  for (const f of ['catalog/catalog.json', 'scripts/scan.js']) assert.ok(fs.existsSync(path.join(t, f)), f);
  const meta = JSON.parse(fs.readFileSync(path.join(t, '.installed.json'), 'utf8'));
  assert.equal(meta.version, pkg.version);
  assert.ok(meta.catalogVersion && !Number.isNaN(Date.parse(meta.installedAt)));
  assert.ok(!fs.existsSync(path.join(home, '.codex')));
});

test('SKILL.md is copied when present in source', async () => {
  const { install } = await import('../skill/scripts/lib/install.js');
  const src = tmp();
  fs.cpSync(path.join(root, 'skill'), src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '# x');
  const home = tmp();
  install({ home, claude: true, sourceDir: src });
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/android-architect/SKILL.md')));
});

test('explicit --codex creates dirs', () => {
  const home = tmp();
  ok(['install', '--codex', '--home', home]);
  assert.ok(fs.existsSync(path.join(home, '.codex/skills/android-architect/.installed.json')));
  assert.ok(!fs.existsSync(path.join(home, '.claude')));
});

test('reinstall removes stale files', () => {
  const home = tmp();
  ok(['install', '--claude', '--home', home]);
  const stale = path.join(home, '.claude/skills/android-architect/scripts/old.js');
  fs.writeFileSync(stale, 'x');
  ok(['install', '--claude', '--home', home]);
  assert.ok(!fs.existsSync(stale));
});

test('symlinked target: only link removed, other dir survives', () => {
  const home = tmp();
  const other = tmp();
  fs.writeFileSync(path.join(other, 'keep.txt'), 'keep');
  fs.mkdirSync(path.join(home, '.claude/skills'), { recursive: true });
  const t = path.join(home, '.claude/skills/android-architect');
  fs.symlinkSync(other, t);
  ok(['install', '--claude', '--home', home]);
  assert.ok(fs.lstatSync(t).isDirectory());
  assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'keep');
  assert.ok(!fs.existsSync(path.join(other, '.installed.json')));
  fs.rmSync(t, { recursive: true });
  fs.symlinkSync(other, t);
  ok(['uninstall', '--home', home]);
  assert.ok(!fs.existsSync(t));
  assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'keep');
});

test('uninstall removes targets', () => {
  const home = tmp();
  ok(['install', '--claude', '--codex', '--home', home]);
  ok(['uninstall', '--home', home]);
  assert.ok(!fs.existsSync(path.join(home, '.claude/skills/android-architect')));
  assert.ok(!fs.existsSync(path.join(home, '.codex/skills/android-architect')));
});

test('no harness and no flag gives error exit 1', () => {
  const r = run(['install', '--home', tmp()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--claude or --codex/);
});

test('unknown command exits 1', () => {
  const r = run(['bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage/);
});

test('doctor reports versions', () => {
  const home = tmp();
  ok(['install', '--claude', '--home', home]);
  const d = JSON.parse(ok(['doctor', '--json', '--home', home]));
  const c = d.harnesses.find((h) => h.name === 'claude');
  assert.equal(c.installed, true);
  assert.equal(c.version, pkg.version);
  assert.equal(d.harnesses.find((h) => h.name === 'codex').installed, false);
  assert.equal(d.optional.graphify, false);
  assert.match(ok(['doctor', '--home', home]), /claude: installed v/);
});

test('doctor detects graphify', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.codex/skills/graphify'), { recursive: true });
  assert.equal(JSON.parse(ok(['doctor', '--json', '--home', home])).optional.graphify, true);
});

test('version prints package and catalog version', () => {
  assert.match(ok(['version']).trim(), new RegExp(`^android-architect ${pkg.version.replace(/\./g, '\\.')} \\(catalog .+\\)$`));
});
