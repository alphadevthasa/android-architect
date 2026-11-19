#!/usr/bin/env node
// Usage: node refresh.js <root>
// Regenerates <root>/.ai and prints a JSON report of what changed. Run it once per repo (a hub refresh does not touch members).
// Exit 0 ok; 1 usage error or refusal (symlink, invalid ADR, newer manifest schema); 2 no manifest or not a Gradle project.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshAiDir } from './lib/refresh.js';

const USAGE = 'usage: node refresh.js <root>';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];

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
  let report;
  try {
    report = refreshAiDir(root, { now: new Date() });
  } catch (e) {
    fail(e.code === 'NO_MANIFEST' ? 2 : 1, e.message);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
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
