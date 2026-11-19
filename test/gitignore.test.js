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

test('buildIndex skips ignored markdown docs', () => {
  const root = fixture({ git: true });
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'secret-notes.md'), '# Hidden Private Notes\n');
    fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Visible Guide\n');
    fs.appendFileSync(path.join(root, '.gitignore'), 'docs/secret-notes.md\n');
    const index = buildIndex(root);
    assert.ok(index.docs.some((d) => d.path === 'docs/guide.md' && d.title.includes('Visible Guide')));
    assert.ok(!index.docs.some((d) => d.path.endsWith('secret-notes.md')));
    assert.ok(!index.docs.some((d) => d.title.includes('Hidden Private Notes')));
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

test('thousands of files are filtered in one pass within a robust bound', () => {
  const root = fixture({ git: true });
  try {
    for (let d = 0; d < 50; d++) {
      const dir = path.join(root, `m${d}`);
      fs.mkdirSync(dir);
      for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(dir, `F${i}.kt`), 'class F\n');
    }
    const t = Date.now();
    const files = listFiles(root, { gitignore: true });
    assert.ok(Date.now() - t < 15000);
    assert.ok(files.length >= 5001);
    assert.ok(!files.includes('generated/A.kt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ignoredPaths handles 20000 paths in one call', () => {
  const root = fixture({ git: true });
  try {
    const paths = Array.from({ length: 20000 }, (_, i) => `dir${i % 50}/file${i}.kt`);
    paths.push('generated/A.kt');
    const set = ignoredPaths(root, paths);
    assert.deepEqual([...set], ['generated/A.kt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('symlinked dir: ignored file under the link target stays excluded, no throw', () => {
  const root = fixture({ git: true });
  try {
    fs.symlinkSync('generated', path.join(root, 'link'));
    const files = listFiles(root, { gitignore: true });
    assert.ok(!files.some((f) => f.startsWith('link/') || f.startsWith('generated/')));
    assert.ok(files.includes('app/B.kt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt repo fails closed with a clear error', () => {
  const root = fixture({ git: true });
  try {
    fs.writeFileSync(path.join(root, '.git', 'index'), 'garbage-not-an-index');
    assert.throws(() => listFiles(root, { gitignore: true }), /^Error: could not determine git-ignored files: /);
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'garbage');
    assert.throws(() => listFiles(root, { gitignore: true }), /could not determine git-ignored files/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('names with spaces, unicode and newlines are filtered correctly', () => {
  const root = fixture({ git: true });
  try {
    const names = ['my notes.md', 'catatan-é-日本.md'];
    let nl = true;
    try {
      fs.writeFileSync(path.join(root, 'line\nbreak.md'), 'x');
      names.push('line\nbreak.md');
    } catch {
      nl = false;
    }
    for (const n of names.slice(0, 2)) fs.writeFileSync(path.join(root, n), 'x');
    fs.appendFileSync(path.join(root, '.gitignore'), 'my notes.md\ncatatan-*\n' + (nl ? 'line?break.md\n' : ''));
    fs.writeFileSync(path.join(root, 'keep me.md'), 'x');
    const files = listFiles(root, { gitignore: true });
    for (const n of names) assert.ok(!files.includes(n));
    assert.ok(files.includes('keep me.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plain non-repo dir gives an empty set under a localized environment', () => {
  const root = fixture({ git: false });
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
  process.env.LANG = 'de_DE.UTF-8';
  process.env.LC_ALL = 'de_DE.UTF-8';
  try {
    assert.equal(ignoredPaths(root, ['secret-notes.md']).size, 0);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
