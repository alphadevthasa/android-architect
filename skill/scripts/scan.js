#!/usr/bin/env node
// Usage: node skill/scripts/scan.js <projectRoot> [--format json|md] [--out <file>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './lib/catalog.js';
import { detectStack } from './lib/detect.js';
import { renderProfileMarkdown } from './lib/report.js';

const USAGE = 'usage: node scan.js <projectRoot> [--format json|md] [--out <file>]';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.xml'];

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { root: null, format: 'json', out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format' || a === '--out') {
      const v = argv[++i];
      if (v === undefined) fail(1, `missing value for ${a}\n${USAGE}`);
      if (a === '--format') opts.format = v;
      else opts.out = v;
    } else if (a.startsWith('--')) {
      fail(1, `unknown option ${a}\n${USAGE}`);
    } else if (opts.root === null) {
      opts.root = a;
    } else {
      fail(1, `unexpected argument ${a}\n${USAGE}`);
    }
  }
  if (opts.root === null) fail(1, USAGE);
  if (opts.format !== 'json' && opts.format !== 'md') fail(1, `unknown format ${opts.format}\n${USAGE}`);
  return opts;
}

export function main(argv) {
  const opts = parseArgs(argv);
  const root = path.resolve(opts.root);
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir || !BUILD_FILES.some((f) => fs.existsSync(path.join(root, f)))) {
    fail(2, `not an Android/Gradle project: ${opts.root}`);
  }
  const catalog = loadCatalog();
  const profile = detectStack(root, catalog);
  const text = opts.format === 'md' ? renderProfileMarkdown(profile, catalog) : JSON.stringify(profile, null, 2) + '\n';
  if (opts.out) fs.writeFileSync(path.resolve(opts.out), text);
  else process.stdout.write(text);
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
