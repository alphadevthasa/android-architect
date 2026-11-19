#!/usr/bin/env node
// Usage: node skill/scripts/recommend-check.js <recommendations.json> --profile <profile.json> [--adr-dir <dir>] [--root <dir>]
// --root: the project root; when <root>/.ai/catalog-overrides exists the check runs against base + overrides.
// Prints { ok, violations, warnings } as JSON (warnings: rejected ADRs with unknown catalog ids). Exit 1 when not ok, 0 when ok, 2 on unreadable input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogError } from './lib/catalog.js';
import { loadCatalogWithOverrides } from './lib/overrides.js';
import { checkRecommendations } from './lib/guardrail.js';
import { loadAdrs, adrWarnings } from './lib/adr.js';

const USAGE = 'usage: node recommend-check.js <recommendations.json> --profile <profile.json> [--adr-dir <dir>] [--root <dir>]';

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
  let rootDir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') {
      profilePath = argv[++i];
      if (profilePath === undefined) fail(1, `missing value for --profile\n${USAGE}`);
    } else if (a === '--adr-dir') {
      adrDir = argv[++i];
      if (adrDir === undefined) fail(1, `missing value for --adr-dir\n${USAGE}`);
    } else if (a === '--root') {
      rootDir = argv[++i];
      if (rootDir === undefined) fail(1, `missing value for --root\n${USAGE}`);
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
  // The profile's own root is "." for scan.js output, so overrides are found through --root (or an absolute profile root).
  if (rootDir === null && typeof profile?.root === 'string' && path.isAbsolute(profile.root)) rootDir = profile.root;
  let catalog;
  try {
    catalog = loadCatalogWithOverrides(undefined, path.resolve(rootDir ?? '.'), { overrides: rootDir !== null }).catalog;
  } catch (err) {
    if (err instanceof CatalogError) fail(1, err.message);
    throw err;
  }
  const result = { ...checkRecommendations(recs, catalog, profile, { adrs }), warnings: adrWarnings(adrs, catalog) };
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
