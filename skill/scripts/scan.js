#!/usr/bin/env node
// Usage: node skill/scripts/scan.js <projectRoot> [--format json|md] [--out <file>] [--no-overrides]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogWithOverrides } from './lib/overrides.js';
import { detectStack } from './lib/detect.js';
import { renderProfileMarkdown } from './lib/report.js';

const USAGE = 'usage: node scan.js <projectRoot> [--format json|md] [--out <file>] [--no-overrides]';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.xml'];

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { root: null, format: 'json', out: null, overrides: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-overrides') opts.overrides = false;
    else if (a === '--format' || a === '--out') {
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
  let catalog;
  let profile;
  try {
    catalog = loadCatalogWithOverrides(undefined, root, { overrides: opts.overrides }).catalog;
    profile = detectStack(root, catalog);
  } catch (e) {
    fail(1, e.message);
  }
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
