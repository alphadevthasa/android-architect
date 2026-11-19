import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listFiles } from '../skill/scripts/lib/walk.js';
import { ignoredPaths } from '../skill/scripts/lib/git.js';
import { buildIndex } from '../skill/scripts/lib/indexer.js';

const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];

function fixture({ git }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-gi-'));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  w('.gitignore', 'secret-notes.md\ngenerated/\n');
  w('secret-notes.md', '# Hidden Private Notes\n');
  w('generated/A.kt', 'class A\n');
  w('app/B.kt', 'class B\n');
  if (git) execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('gitignore option drops ignored files; default keeps them', () => {
  const root = fixture({ git: true });
  try {
    const on = listFiles(root, { gitignore: true });
    assert.ok(on.includes('app/B.kt'));
    assert.ok(!on.includes('secret-notes.md'));
    assert.ok(!on.includes('generated/A.kt'));
    const off = listFiles(root);
    for (const f of ['app/B.kt', 'secret-notes.md', 'generated/A.kt']) assert.ok(off.includes(f));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('non-git directory: no filtering, empty ignored set', () => {
  const root = fixture({ git: false });
  try {
    const on = listFiles(root, { gitignore: true });
    for (const f of ['app/B.kt', 'secret-notes.md', 'generated/A.kt']) assert.ok(on.includes(f));
    assert.equal(ignoredPaths(root, ['secret-notes.md']).size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildIndex skips ignored docs', () => {
  const root = fixture({ git: true });
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'ignored.md'), '# Visible Doc\n');
    fs.appendFileSync(path.join(root, '.gitignore'), 'docs/ignored.md\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# Readme Title\n');
    const index = buildIndex(root);
    assert.ok(index.docs.some((d) => d.path === 'README.md'));
    assert.ok(!index.docs.some((d) => d.path === 'docs/ignored.md'));
    assert.ok(!index.docs.some((d) => d.path === 'generated/A.kt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tracked file matching .gitignore is still listed', () => {
  const root = fixture({ git: true });
  try {
    execFileSync('git', ['add', '-f', 'secret-notes.md'], { cwd: root });
    execFileSync('git', [...G, 'commit', '-q', '-m', 'x'], { cwd: root });
    assert.ok(listFiles(root, { gitignore: true }).includes('secret-notes.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subdirectory root: paths relative to root are checked', () => {
  const root = fixture({ git: true });
  try {
    const sub = path.join(root, 'app');
    fs.writeFileSync(path.join(sub, 'secret-notes.md'), 'x');
    const on = listFiles(sub, { gitignore: true });
    assert.ok(on.includes('B.kt'));
    assert.ok(!on.includes('secret-notes.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('20000 paths in one call returns quickly', () => {
  const root = fixture({ git: true });
  try {
    const paths = Array.from({ length: 20000 }, (_, i) => `dir${i % 50}/file${i}.kt`);
    paths.push('generated/A.kt');
    const t = Date.now();
    const set = ignoredPaths(root, paths);
    assert.ok(Date.now() - t < 5000);
    assert.deepEqual([...set], ['generated/A.kt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
