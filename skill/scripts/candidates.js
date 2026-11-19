#!/usr/bin/env node
// Usage: node skill/scripts/candidates.js <projectRoot>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './lib/catalog.js';
import { detectStack } from './lib/detect.js';
import { candidatePaths } from './lib/candidates.js';

const USAGE = 'usage: node candidates.js <projectRoot>';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.xml'];

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

export function main(argv) {
  if (argv.length !== 1 || argv[0].startsWith('--')) fail(1, USAGE);
  const root = path.resolve(argv[0]);
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir || !BUILD_FILES.some((f) => fs.existsSync(path.join(root, f)))) {
    fail(2, `not an Android/Gradle project: ${argv[0]}`);
  }
  const catalog = loadCatalog();
  let profile;
  try {
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
