#!/usr/bin/env node
// Usage: node skill/scripts/reuse.js <projectRoot> [--format json|md]
// Detects duplicated layouts, composables and utilities, competing base classes, repeated boilerplate and hardcoded tokens (lib/reuse.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectReuse } from './lib/reuse.js';
import { renderComponentsBlock } from './lib/knowledge.js';
import { redact, redactJson } from './lib/redact.js';

const USAGE = 'usage: node reuse.js <projectRoot> [--format json|md]';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.xml'];

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { root: null, format: 'json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') {
      const v = argv[++i];
      if (v === undefined) fail(1, `missing value for ${a}\n${USAGE}`);
      opts.format = v;
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
  let reuse;
  try {
    reuse = detectReuse(root);
  } catch (e) {
    fail(1, redact(String(e.message)).text);
  }
  process.stdout.write(opts.format === 'md' ? redact(renderComponentsBlock(reuse)).text + '\n' : JSON.stringify(redactJson(reuse), null, 2) + '\n');
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
