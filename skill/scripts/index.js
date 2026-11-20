#!/usr/bin/env node
// Usage: node index.js build <root> [--out <file>]
//        node index.js query "<terms>" [--index <file>] [--limit N] [--kind source|gradle|doc]
// Run from a vendored .ai/tools/scripts copy, it first checks .ai/tools against .ai/manifest.json and exits 3 when they
// differ, unless --trust-modified-tools is given.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Only integrity.js (Node builtins, hash.js, manifest.js) is imported statically: a vendored copy checks itself before
// it loads any other module of .ai/tools.
import { TRUST_FLAG, vendoredRefusal } from './lib/integrity.js';

const USAGE =
  'usage: node index.js build <root> [--out <file>] [--trust-modified-tools]\n' +
  '       node index.js query "<terms>" [--index <file>] [--limit N] [--kind source|gradle|doc] [--trust-modified-tools]';
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

function build(opts, { loadCatalog, headCommit, buildIndex }) {
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

function query(opts, { queryIndex }) {
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

export async function main(argv) {
  const refusal = vendoredRefusal(import.meta.url, argv);
  if (refusal) fail(3, refusal);
  const opts = parseArgs(argv.filter((a) => a !== TRUST_FLAG));
  if (opts.cmd === 'build') {
    const { loadCatalog } = await import('./lib/catalog.js');
    const { headCommit } = await import('./lib/git.js');
    const { buildIndex } = await import('./lib/indexer.js');
    build(opts, { loadCatalog, headCommit, buildIndex });
  } else {
    const { queryIndex } = await import('./lib/indexer.js');
    query(opts, { queryIndex });
  }
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
