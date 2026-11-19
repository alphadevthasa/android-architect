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

test('skills dir symlink: install lands in real dir, nothing else touched', () => {
  const home = tmp();
  const real = tmp();
  fs.writeFileSync(path.join(real, 'other.txt'), 'o');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.symlinkSync(real, path.join(home, '.claude/skills'));
  ok(['install', '--claude', '--home', home]);
  assert.ok(fs.existsSync(path.join(real, 'android-architect/.installed.json')));
  assert.equal(fs.readFileSync(path.join(real, 'other.txt'), 'utf8'), 'o');
  assert.deepEqual(fs.readdirSync(real).sort(), ['android-architect', 'other.txt']);
});

test('source overlapping target is refused and nothing is touched', async () => {
  const { install } = await import('../skill/scripts/lib/install.js');
  const home = tmp();
  const target = path.join(home, '.claude/skills/android-architect');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(root, 'skill'), target, { recursive: true });
  fs.writeFileSync(path.join(target, '.installed.json'), '{}');
  assert.throws(() => install({ home, claude: true, sourceDir: target }), /overlap/);
  assert.ok(fs.existsSync(path.join(target, 'scripts/scan.js')));
  // source containing the target
  assert.throws(() => install({ home, claude: true, sourceDir: path.join(home, '.claude') }), /overlap|catalog/);
  assert.ok(fs.existsSync(path.join(target, 'scripts/scan.js')));
});

test('failed copy leaves old install intact and no staging dir', async () => {
  const { install } = await import('../skill/scripts/lib/install.js');
  const home = tmp();
  ok(['install', '--claude', '--home', home]);
  const skills = path.join(home, '.claude/skills');
  const before = fs.readFileSync(path.join(skills, 'android-architect/.installed.json'), 'utf8');
  const boom = (from, to) => {
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, 'partial'), 'x');
    throw new Error('disk full');
  };
  assert.throws(() => install({ home, claude: true, sourceDir: path.join(root, 'skill'), _copy: boom }), /disk full/);
  assert.equal(fs.readFileSync(path.join(skills, 'android-architect/.installed.json'), 'utf8'), before);
  assert.ok(fs.existsSync(path.join(skills, 'android-architect/scripts/scan.js')));
  assert.deepEqual(fs.readdirSync(skills), ['android-architect']);
});

test('second harness failure names the already installed one', async () => {
  const { install } = await import('../skill/scripts/lib/install.js');
  const home = tmp();
  let n = 0;
  const flaky = (from, to) => {
    if (++n === 2) throw new Error('boom');
    fs.cpSync(from, to, { recursive: true });
  };
  assert.throws(
    () => install({ home, claude: true, codex: true, sourceDir: path.join(root, 'skill'), _copy: flaky }),
    (e) => /boom/.test(e.message) && e.message.includes(path.join(fs.realpathSync(home), '.claude/skills/android-architect')),
  );
});

test('foreign directory is refused without --force, allowed with it; doctor reports partial', () => {
  const home = tmp();
  const t = path.join(home, '.claude/skills/android-architect');
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(path.join(t, 'mine.txt'), 'm');
  const d = JSON.parse(ok(['doctor', '--json', '--home', home]));
  assert.equal(d.harnesses[0].installed, false);
  assert.equal(d.harnesses[0].partial, true);
  let r = run(['install', '--claude', '--home', home]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--force/);
  r = run(['uninstall', '--home', home]);
  assert.equal(r.status, 1);
  assert.ok(fs.existsSync(path.join(t, 'mine.txt')));
  ok(['install', '--claude', '--force', '--home', home]);
  assert.ok(!fs.existsSync(path.join(t, 'mine.txt')));
  assert.ok(fs.existsSync(path.join(t, '.installed.json')));
});

test('M5: --home without a value, or followed by another flag, is a usage error', () => {
  for (const args of [['doctor', '--home'], ['install', '--claude', '--home', '--force'], ['doctor', '--home', '--json']]) {
    const r = run(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /--home/, args.join(' '));
  }
});

const FIXTURE = path.join(root, 'test/fixtures/legacy-java-mvp');
const fixtureCopy = () => {
  const dir = tmp();
  const proj = path.join(dir, 'proj');
  fs.cpSync(FIXTURE, proj, { recursive: true });
  return { dir, proj };
};

test('usage lists all seven commands', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  for (const c of ['install', 'uninstall', 'update', 'init', 'refresh', 'doctor', 'version']) assert.ok(r.stderr.includes(c), c);
});

test('update reinstalls into harnesses that have an install and prints the arrow line', () => {
  const home = tmp();
  ok(['install', '--claude', '--home', home]);
  const metaFile = path.join(home, '.claude/skills/android-architect/.installed.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, version: '0.1.0' }));
  const out = ok(['update', '--home', home]);
  assert.match(out, new RegExp(`claude: 0\\.1\\.0 \\(catalog ${meta.catalogVersion}\\) -> ${pkg.version.replace(/\./g, '\\.')} \\(catalog ${meta.catalogVersion}\\)`));
  assert.ok(!out.includes('codex:'));
  assert.match(out, /Run "refresh" in each project/);
  assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).version, pkg.version);
  assert.ok(!fs.existsSync(path.join(home, '.codex')));
});

test('update with nothing installed exits 1', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude'));
  const r = run(['update', '--home', home]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing installed/);
});

test('init --json writes .ai and reports written', () => {
  const { dir, proj } = fixtureCopy();
  try {
    const out = JSON.parse(ok(['init', '--root', proj, '--json']));
    assert.ok(out.written.includes('.ai/manifest.json'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(proj, '.ai/manifest.json'), 'utf8')).toolVersion, pkg.version);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('init prints a human summary with the pointer rerun command', () => {
  const { dir, proj } = fixtureCopy();
  try {
    fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# mine\n');
    const out = ok(['init', '--root', proj]);
    assert.match(out, /written/i);
    assert.match(out, /npx android-architect init --append-pointers/);
    assert.equal(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8'), '# mine\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('init defaults --root to the cwd', () => {
  const { dir, proj } = fixtureCopy();
  try {
    execFileSync(process.execPath, ['--import', helper, cli, 'init'], { cwd: proj, encoding: 'utf8' });
    assert.ok(fs.existsSync(path.join(proj, '.ai/manifest.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('init rejects unknown flags and non-Gradle roots', () => {
  const { dir, proj } = fixtureCopy();
  try {
    assert.equal(run(['init', '--root', proj, '--bogus']).status, 1);
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    const r = run(['init', '--root', empty]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not an Android\/Gradle project/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('init --workspace initializes hub and members', () => {
  const dir = tmp();
  try {
    const hub = path.join(dir, 'hub');
    const member = path.join(dir, 'member');
    fs.cpSync(FIXTURE, hub, { recursive: true });
    fs.cpSync(FIXTURE, member, { recursive: true });
    const out = JSON.parse(ok(['init', '--root', hub, '--workspace', member, '--json']));
    assert.ok(out.hub.written.includes('.ai/manifest.json'));
    assert.ok(out.members.member.written.includes('.ai/manifest.json'));
    assert.ok(fs.existsSync(path.join(hub, '.ai/repos.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh without init exits 1 and says to run init first', () => {
  const { dir, proj } = fixtureCopy();
  try {
    const r = run(['refresh', '--root', proj]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /run init first/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh after init prints the catalog line, and --json the report', () => {
  const { dir, proj } = fixtureCopy();
  try {
    ok(['init', '--root', proj]);
    const out = ok(['refresh', '--root', proj]);
    assert.match(out, /Catalog: \S+ -> \S+/);
    assert.match(out, /Candidates/);
    const json = JSON.parse(ok(['refresh', '--root', proj, '--json']));
    assert.equal(json.tool.to, pkg.version);
    assert.ok(Array.isArray(json.notes));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
