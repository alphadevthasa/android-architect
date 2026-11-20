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
    for (const [name, r] of Object.entries(cases)) {
      if (name === 'reuse' || name === 'cli doctor' || name === 'fitness' || name === 'ai-status' || name === 'recommend-check profile.root') {
        // these may legitimately not read the manifest, but must never crash with a stack or path
      } else {
        assert.notEqual(r.status, 0, `${name}: exit ${r.status} ${r.stdout.slice(0, 200)}`);
      }
      const err = r.stderr;
      assert.doesNotMatch(err, /\n\s+at |file:\/\//, `${name}: stack trace\n${err}`);
      assert.equal(err.includes(dir) || err.includes(aux), false, `${name}: absolute path\n${err}`);
      assert.ok(err.trim().split('\n').length <= 1, `${name}: single line\n${err}`);
      assert.doesNotMatch(err, /Invalid catalog/, name);
    }
    for (const name of ['scan', 'candidates']) assert.match(cases[name].stderr, /cannot read \.ai\/manifest\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(aux, { recursive: true, force: true });
  }
});
