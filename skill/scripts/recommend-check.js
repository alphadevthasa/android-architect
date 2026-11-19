#!/usr/bin/env node
// Usage: node skill/scripts/recommend-check.js <recommendations.json> --profile <profile.json> [--adr-dir <dir>]
// Prints { ok, violations } as JSON. Exit 1 when not ok, 0 when ok, 2 on unreadable input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './lib/catalog.js';
import { checkRecommendations } from './lib/guardrail.js';
import { loadAdrs } from './lib/adr.js';

const USAGE = 'usage: node recommend-check.js <recommendations.json> --profile <profile.json> [--adr-dir <dir>]';

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (err) {
    return fail(2, `cannot read ${what} ${file}: ${err.message}`);
  }
}

export function main(argv) {
  let recsPath = null;
  let profilePath = null;
  let adrDir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') {
      profilePath = argv[++i];
      if (profilePath === undefined) fail(1, `missing value for --profile\n${USAGE}`);
    } else if (a === '--adr-dir') {
      adrDir = argv[++i];
      if (adrDir === undefined) fail(1, `missing value for --adr-dir\n${USAGE}`);
    } else if (a.startsWith('--')) fail(1, `unknown option ${a}\n${USAGE}`);
    else if (recsPath === null) recsPath = a;
    else fail(1, `unexpected argument ${a}\n${USAGE}`);
  }
  if (recsPath === null || profilePath === null) fail(1, USAGE);
  const recs = readJson(recsPath, 'recommendations');
  const profile = readJson(profilePath, 'profile');
  let adrs = [];
  if (adrDir !== null) {
    try {
      adrs = loadAdrs(path.resolve(adrDir));
    } catch (err) {
      fail(2, `cannot read ADRs ${adrDir}: ${err.message}`);
    }
  }
  const result = checkRecommendations(recs, loadCatalog(), profile, { adrs });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exit(1);
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
