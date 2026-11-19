#!/usr/bin/env node
// Usage: node index.js build <root> [--out <file>]
//        node index.js query "<terms>" [--index <file>] [--limit N] [--kind source|gradle|doc]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './lib/catalog.js';
import { headCommit } from './lib/git.js';
import { buildIndex, queryIndex } from './lib/indexer.js';

const USAGE =
  'usage: node index.js build <root> [--out <file>]\n' +
  '       node index.js query "<terms>" [--index <file>] [--limit N] [--kind source|gradle|doc]';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
const KINDS = ['source', 'gradle', 'doc'];

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'build' && cmd !== 'query') fail(1, USAGE);
  const opts = { cmd, positional: null, out: null, index: null, limit: 10, kind: undefined };
  const valued = cmd === 'build' ? ['--out'] : ['--index', '--limit', '--kind'];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (valued.includes(a)) {
      const v = rest[++i];
      if (v === undefined) fail(1, `missing value for ${a}\n${USAGE}`);
      if (a === '--out') opts.out = v;
      else if (a === '--index') opts.index = v;
      else if (a === '--kind') opts.kind = v;
      else opts.limit = Number(v);
    } else if (a.startsWith('--')) {
      fail(1, `unknown option ${a}\n${USAGE}`);
    } else if (opts.positional === null) {
      opts.positional = a;
    } else {
      fail(1, `unexpected argument ${a}\n${USAGE}`);
    }
  }
  if (opts.positional === null) fail(1, USAGE);
  if (opts.kind !== undefined && !KINDS.includes(opts.kind)) fail(1, `unknown kind ${opts.kind}\n${USAGE}`);
  if (!Number.isInteger(opts.limit) || opts.limit < 1) fail(1, `invalid --limit\n${USAGE}`);
  return opts;
}

function build(opts) {
  const root = path.resolve(opts.positional);
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir || !BUILD_FILES.some((f) => fs.existsSync(path.join(root, f)))) {
    fail(2, `not an Android/Gradle project: ${opts.positional}`);
  }
  const commit = headCommit(root);
  let index;
  try {
    index = buildIndex(root, {
      now: new Date(),
      commit,
      catalogVersion: loadCatalog().catalogVersion,
    });
  } catch (e) {
    fail(1, e.message);
  }
  const out = path.resolve(opts.out ?? path.join(root, '.ai', 'index', 'index.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(index) + '\n');
  process.stdout.write(JSON.stringify({ out, docs: index.docs.length, commit }) + '\n');
}

function query(opts) {
  const file = path.resolve(opts.index ?? path.join('.ai', 'index', 'index.json'));
  let index;
  try {
    index = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(2, `missing or unreadable index: ${file}`);
  }
  if (index?.schemaVersion !== 1 || !Array.isArray(index.docs)) fail(2, `unsupported index: ${file}`);
  const hits = queryIndex(index, opts.positional, { limit: opts.limit, kind: opts.kind });
  process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.cmd === 'build') build(opts);
  else query(opts);
}

const isMain = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (process.argv[1] && isMain()) {
  main(process.argv.slice(2));
}
