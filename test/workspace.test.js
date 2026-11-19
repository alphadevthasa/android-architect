import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { publishedArtifacts, linkWorkspace, siblingRepos } from '../skill/scripts/lib/workspace.js';

const INIT = path.resolve('skill/scripts/init-ai.js');
const FX = path.resolve('test/fixtures/workspace');
let tmp, hub, lib;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ws-'));
  hub = path.join(tmp, 'hub-app');
  lib = path.join(tmp, 'lib-core');
  fs.cpSync(path.join(FX, 'hub-app'), hub, { recursive: true });
  fs.cpSync(path.join(FX, 'lib-core'), lib, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const init = (args, cwd = hub) => spawnSync(process.execPath, [INIT, ...args], { cwd, encoding: 'utf8' });
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('publishedArtifacts finds the maven-publish module', () => {
  assert.deepEqual(publishedArtifacts(lib), ['com.example.core:core-net']);
  assert.deepEqual(publishedArtifacts(hub), []);
});

test('publishedArtifacts honours artifactId, groupId and skips unresolved values', () => {
  fs.writeFileSync(
    path.join(lib, 'core-net/build.gradle.kts'),
    `plugins { id("maven-publish") }\npublishing { publications { create<MavenPublication>("r") { groupId = "org.x"; artifactId = "renamed" } } }\n`,
  );
  assert.deepEqual(publishedArtifacts(lib), ['org.x:renamed']);
  fs.writeFileSync(path.join(lib, 'core-net/build.gradle.kts'), `plugins { id("maven-publish") }\ngroup = "\${props.g}"\n`);
  assert.deepEqual(publishedArtifacts(lib), []);
});

test('publishedArtifacts ignores group literals inside parentheses', () => {
  fs.writeFileSync(
    path.join(lib, 'core-net/build.gradle.kts'),
    `plugins { id("maven-publish") }\ndependencies { implementation("a:b:1") { exclude(group = "wrong") } }\ngroup = "com.example.core"\n`,
  );
  assert.deepEqual(publishedArtifacts(lib), ['com.example.core:core-net']);
});

test('linkWorkspace links the hub dependency to the producing repo', () => {
  const repos = linkWorkspace(hub, [lib], { confirmed: true });
  assert.equal(repos.schemaVersion, 1);
  assert.equal(repos.hub, '.');
  assert.deepEqual(repos.repos.map((r) => [r.name, r.path, r.confirmed]), [
    ['hub-app', '.', true],
    ['lib-core', '../lib-core', true],
  ]);
  assert.equal(repos.links.length, 1);
  const l = repos.links[0];
  assert.deepEqual([l.consumer, l.producer, l.artifact, l.version], ['hub-app', 'lib-core', 'com.example.core:core-net', '1.4.0']);
  const line = fs.readFileSync(path.join(hub, l.file), 'utf8').split('\n')[l.line - 1];
  assert.match(line, /core-net:1\.4\.0/);
});

test('siblingRepos returns only Gradle sibling dirs, sorted, without the hub', () => {
  fs.mkdirSync(path.join(tmp, 'plain'));
  assert.deepEqual(siblingRepos(hub), [fs.realpathSync(lib)]);
});

test('init-ai --workspace writes hub repos.json and a thin member', () => {
  const r = init(['.', '--workspace', '../lib-core']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['hub', 'members', 'repos']);
  assert.ok(out.hub.written.includes('.ai/repos.json'));
  assert.deepEqual(json(path.join(hub, '.ai/manifest.json')).workspace, { role: 'hub', hub: '.' });
  assert.match(fs.readFileSync(path.join(hub, '.ai/README.md'), 'utf8'), /Workspace: hub \(1 repo\)/);
  assert.equal(json(path.join(hub, '.ai/repos.json')).links.length, 1);

  const m = path.join(lib, '.ai');
  assert.deepEqual(json(path.join(m, 'manifest.json')).workspace, { role: 'member', hub: '../hub-app' });
  assert.match(fs.readFileSync(path.join(m, 'README.md'), 'utf8'), /Workspace: member of \.\.\/hub-app/);
  assert.match(fs.readFileSync(path.join(m, 'README.md'), 'utf8'), /live in the hub/);
  for (const gone of ['knowledge/architecture-target.md', 'knowledge/conventions.md', 'migration/roadmap.md', 'workflows', 'repos.json']) {
    assert.equal(fs.existsSync(path.join(m, gone)), false, gone);
  }
  assert.ok(fs.existsSync(path.join(m, 'index/index.json')));
  assert.ok(fs.existsSync(path.join(m, 'tools/scripts/index.js')));
  assert.ok(fs.existsSync(path.join(m, 'candidates.json')));
});

test('repos.json is user-owned after the first write', () => {
  assert.equal(init(['.', '--workspace', '../lib-core']).status, 0);
  const f = path.join(hub, '.ai/repos.json');
  fs.writeFileSync(f, '{"mine":true}\n');
  const out = JSON.parse(init(['.', '--workspace', '../lib-core']).stdout);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"mine":true}\n');
  assert.ok(out.hub.kept.includes('.ai/repos.json'));
  assert.ok(!out.hub.written.includes('.ai/repos.json'));
});

test('bare --workspace uses sibling repos as unconfirmed', () => {
  const out = JSON.parse(init(['.', '--workspace']).stdout);
  assert.deepEqual(Object.keys(out.members), ['lib-core']);
  assert.equal(out.repos.repos[1].confirmed, false);
});

test('invalid workspace paths exit 1 before anything is written', () => {
  fs.mkdirSync(path.join(hub, 'nested'));
  fs.writeFileSync(path.join(hub, 'nested/build.gradle'), '');
  fs.mkdirSync(path.join(tmp, 'plain'));
  const bad = ['.', '../hub-app', '../missing', '../plain', 'nested', '..'];
  for (const p of bad) {
    const r = init(['.', '--workspace', '../lib-core', p]);
    assert.equal(r.status, 1, p);
    assert.match(r.stderr, /workspace/, p);
  }
  assert.equal(fs.existsSync(path.join(hub, '.ai')), false);
  assert.equal(fs.existsSync(path.join(lib, '.ai')), false);
});

test('--workspace --local needs every member to be a git repo, checked before writing', () => {
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, stdio: 'ignore' });
  git(hub, 'init');
  let r = init(['.', '--workspace', '../lib-core', '--local']);
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(path.join(hub, '.ai')), false);
  git(lib, 'init');
  r = init(['.', '--workspace', '../lib-core', '--local']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(lib, '.git/info/exclude'), 'utf8'), /\.ai\//);
});

test('a symlinked member .ai is refused', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ws-out-'));
  try {
    fs.symlinkSync(outside, path.join(lib, '.ai'));
    const r = init(['.', '--workspace', '../lib-core']);
    assert.equal(r.status, 1);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.existsSync(path.join(hub, '.ai')), false);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
