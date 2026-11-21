import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const S = path.resolve('skill/scripts');
const NO_NET = path.resolve('test/helpers/no-network.mjs');
const BIN = path.resolve('bin/cli.js');

test('every entry point that reads the manifest fails plainly on a corrupt manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-mcli-'));
  const aux = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-mcli-aux-'));
  try {
    fs.cpSync(path.resolve('test/fixtures/modern-compose'), dir, { recursive: true });
    fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.ai/manifest.json'), '{ nope');
    const profile = path.join(aux, 'profile.json');
    fs.writeFileSync(profile, JSON.stringify({ schemaVersion: 1, root: dir, dimensions: {} }));
    const recs = path.join(aux, 'recs.json');
    fs.writeFileSync(recs, JSON.stringify({ schemaVersion: 1, catalogVersion: 'x', generatedAt: '2026-11-20', dimensions: [], steps: [] }));
    const node = (script, args) => spawnSync(process.execPath, ['--import', NO_NET, script, ...args], { encoding: 'utf8' });
    const cases = {
      scan: node(path.join(S, 'scan.js'), [dir]),
      candidates: node(path.join(S, 'candidates.js'), [dir]),
      features: node(path.join(S, 'features.js'), [dir]),
      'lib-update': node(path.join(S, 'lib-update.js'), [dir]),
      'migration-plan': node(path.join(S, 'migration-plan.js'), [dir, '--recs', recs]),
      'recommend-check --root': node(path.join(S, 'recommend-check.js'), [recs, '--profile', profile, '--root', dir]),
      'recommend-check profile.root': node(path.join(S, 'recommend-check.js'), [recs, '--profile', profile]),
      playbook: node(path.join(S, 'playbook.js'), ['apply', 'xml-layouts', 'compose', dir]),
      refresh: node(path.join(S, 'refresh.js'), [dir]),
      'init-ai': node(path.join(S, 'init-ai.js'), [dir]),
      fitness: node(path.join(S, 'fitness.js'), [dir]),
      'ai-status': node(path.join(S, 'ai-status.js'), [dir]),
      reuse: node(path.join(S, 'reuse.js'), [dir]),
      'cli init': node(BIN, ['init', '--root', dir]),
      'cli refresh': node(BIN, ['refresh', '--root', dir]),
      'cli doctor': node(BIN, ['doctor', '--root', dir]),
    };
    // Pinned exit codes: reuse and doctor do not read the manifest; every other entry point fails with 1 (or 2 for input
    // that cannot be read), never 0 and never a crash.
    const EXPECTED = {
      reuse: 0, 'cli doctor': 0, 'recommend-check profile.root': 1, 'ai-status': 1, fitness: 1,
      scan: 1, candidates: 1, features: 1, 'lib-update': 1, 'migration-plan': 1, 'recommend-check --root': 1,
      playbook: 1, refresh: 1, 'init-ai': 1, 'cli init': 1, 'cli refresh': 1,
    };
    assert.deepEqual(Object.keys(EXPECTED).sort(), Object.keys(cases).sort());
    for (const [name, r] of Object.entries(cases)) {
      assert.equal(r.status, EXPECTED[name], `${name}: exit ${r.status} ${r.stdout.slice(0, 200)}\n${r.stderr}`);
      const err = r.stderr;
      assert.doesNotMatch(err, /\n\s+at |file:\/\//, `${name}: stack trace\n${err}`);
      assert.equal(err.includes(dir) || err.includes(aux), false, `${name}: absolute path\n${err}`);
      assert.ok(err.trim().split('\n').length <= 1, `${name}: single line\n${err}`);
      assert.doesNotMatch(err, /Invalid catalog/, name);
    }
    // one plain message everywhere: no "invalid manifest", no repeated "cannot read", no refresh/init advice
    for (const name of ['scan', 'candidates', 'features', 'lib-update', 'ai-status', 'refresh', 'init-ai', 'fitness']) {
      const err = cases[name].stderr;
      assert.match(err, /cannot read \.ai\/manifest\.json: it is not valid JSON; fix or delete \.ai\/manifest\.json by hand, or restore it from git/, name);
      assert.doesNotMatch(err, /invalid manifest/, name);
      assert.equal(err.match(/cannot read/g).length, 1, name);
    }
    // a corrupt manifest might hide a workspace member: fitness writes nothing
    assert.equal(fs.existsSync(path.join(dir, '.ai/fitness')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(aux, { recursive: true, force: true });
  }
});
