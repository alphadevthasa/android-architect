#!/usr/bin/env node
// Usage: node skill/scripts/candidates.js <projectRoot> [--no-overrides]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogWithOverrides } from './lib/overrides.js';
import { detectStack } from './lib/detect.js';
import { candidatePaths } from './lib/candidates.js';

const USAGE = 'usage: node candidates.js <projectRoot> [--no-overrides]';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.xml'];

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

export function main(argv) {
  const args = argv.filter((a) => a !== '--no-overrides');
  if (args.length !== 1 || args[0].startsWith('--') || argv.length - args.length > 1) fail(1, USAGE);
  const overrides = args.length === argv.length;
  const root = path.resolve(args[0]);
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir || !BUILD_FILES.some((f) => fs.existsSync(path.join(root, f)))) {
    fail(2, `not an Android/Gradle project: ${args[0]}`);
  }
  let catalog;
  let profile;
  try {
    catalog = loadCatalogWithOverrides(undefined, root, { overrides }).catalog;
    profile = detectStack(root, catalog);
  } catch (e) {
    fail(1, e.message);
  }
  process.stdout.write(JSON.stringify(candidatePaths(profile, catalog), null, 2) + '\n');
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
