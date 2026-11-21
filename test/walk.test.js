import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, readLines, SECRET_FILE_PATTERNS, IGNORED_DIRS } from '../skill/scripts/lib/walk.js';

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function mkTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-'));
  made.push(root);
  for (const f of files) {
    const abs = path.join(root, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
  }
  return root;
}

test('lists files sorted with posix separators', () => {
  const root = mkTree(['a/B.kt', 'a/b/C.java', 'build.gradle']);
  assert.deepEqual(listFiles(root), ['a/B.kt', 'a/b/C.java', 'build.gradle']);
});

test('skips ignored dirs', () => {
  const root = mkTree([
    'keep.kt', 'build/x.kt', 'app/build/y.kt', '.gradle/z.bin', '.git/HEAD',
    'node_modules/m/i.js', '.ai/n.md', '.idea/w.xml', 'graphify-out/g.json', 'app/src/K.kt',
  ]);
  assert.deepEqual(listFiles(root), ['app/src/K.kt', 'keep.kt']);
  assert.deepEqual([...IGNORED_DIRS].sort(),
    ['.ai', '.git', '.gradle', '.idea', 'build', 'graphify-out', 'node_modules']);
});

test('extraIgnoreDirs adds names', () => {
  const root = mkTree(['a/x.kt', 'gen/y.kt']);
  assert.deepEqual(listFiles(root, { extraIgnoreDirs: ['gen'] }), ['a/x.kt']);
});

test('skips secret files', () => {
  const root = mkTree([
    'local.properties', 'app/release.jks', 'keystore.properties', 'app/google-services.json',
    '.env.prod', '.env', 'a.keystore', 'b.p12', 'gradle.properties',
  ]);
  assert.deepEqual(listFiles(root), ['gradle.properties']);
  assert.ok(SECRET_FILE_PATTERNS.every((r) => r instanceof RegExp));
});

test('does not follow symlink outside root', () => {
  const root = mkTree(['ok.kt']);
  const outside = mkTree(['x.kt']);
  fs.symlinkSync(outside, path.join(root, 'link'));
  fs.symlinkSync(path.join(outside, 'x.kt'), path.join(root, 'file-link.kt'));
  assert.deepEqual(listFiles(root), ['ok.kt']);
});

test('lists file symlink inside root under link path, traverses dir symlink once', () => {
  const root = mkTree(['real/F.kt', 'T.kt']);
  fs.symlinkSync(path.join(root, 'T.kt'), path.join(root, 'alias.kt'));
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'zlink'));
  const out = listFiles(root);
  assert.ok(out.includes('alias.kt'));
  assert.equal(out.filter((p) => p.endsWith('F.kt')).length, 1);
});

test('canonical path wins over a symlink that sorts first', () => {
  const root = mkTree(['real/F.kt']);
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alink'));
  const out = listFiles(root);
  assert.ok(out.includes('real/F.kt'));
  assert.ok(!out.includes('alink/F.kt'));
});

test('canonical deep path wins over a shallow symlink', () => {
  const root = mkTree(['x/y/deep/F.kt']);
  fs.symlinkSync(path.join(root, 'x/y/deep'), path.join(root, 'alink'));
  assert.deepEqual(listFiles(root), ['x/y/deep/F.kt']);
});

test('survives symlink loop', () => {
  const root = mkTree(['a/F.kt']);
  fs.symlinkSync('..', path.join(root, 'a', 'loop'));
  assert.deepEqual(listFiles(root), ['a/F.kt']);
});

test('readLines handles CRLF and BOM', () => {
  const root = mkTree([]);
  const f = path.join(root, 't.txt');
  fs.writeFileSync(f, '﻿one\r\ntwo\nthree');
  assert.deepEqual(readLines(f), ['one', 'two', 'three']);
});

test('M1: secret file patterns are case-insensitive', () => {
  const root = mkTree(['app/Release.JKS', '.ENV', 'Local.properties', 'KEYSTORE.Properties', 'a/Google-Services.JSON', 'b.P12', 'Main.kt']);
  assert.deepEqual(listFiles(root), ['Main.kt']);
});

test('M1: a symlink to a secret file is excluded', () => {
  const root = mkTree(['keys/release.jks', 'Main.kt']);
  fs.symlinkSync(path.join(root, 'keys/release.jks'), path.join(root, 'innocent.txt'));
  fs.symlinkSync(path.join(root, 'keys/release.jks'), path.join(root, 'Upper.JKS'));
  assert.deepEqual(listFiles(root), ['Main.kt']);
});

test('M1: a symlink into an ignored dir is excluded', () => {
  const root = mkTree(['build/gen/G.kt', 'Main.kt']);
  fs.symlinkSync(path.join(root, 'build/gen'), path.join(root, 'gen-link'));
  fs.symlinkSync(path.join(root, 'build/gen/G.kt'), path.join(root, 'G-link.kt'));
  assert.deepEqual(listFiles(root), ['Main.kt']);
});
