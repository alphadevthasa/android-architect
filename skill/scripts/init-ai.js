#!/usr/bin/env node
// Usage: node init-ai.js <root> [--local] [--append-pointers] [--workspace [path ...]]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject, isGradleProject } from './lib/init.js';

const USAGE = 'usage: node init-ai.js <root> [--local] [--append-pointers] [--workspace [path ...]]\n(relative --workspace paths resolve against <root>)';

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { root: null, local: false, appendPointers: false, workspace: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') opts.local = true;
    else if (a === '--append-pointers') opts.appendPointers = true;
    else if (a === '--workspace') {
      opts.workspace = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.workspace.push(argv[++i]);
    } else if (a.startsWith('--')) fail(1, `unknown option ${a}\n${USAGE}`);
    else if (opts.root === null) opts.root = a;
    else fail(1, `unexpected argument ${a}\n${USAGE}`);
  }
  if (opts.root === null) fail(1, USAGE);
  return opts;
}

export function main(argv) {
  const opts = parseArgs(argv);
  const root = path.resolve(opts.root);
  if (!isGradleProject(root)) fail(2, `not an Android/Gradle project: ${opts.root}`);
  let result;
  try {
    result = initProject(root, { now: new Date(), local: opts.local, appendPointers: opts.appendPointers, workspace: opts.workspace });
  } catch (e) {
    fail(1, e.message);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
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
