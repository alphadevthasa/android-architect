#!/usr/bin/env node
// Usage: node skill/scripts/migration-plan.js <root> --recs <file> [--profile <file>] [--adr-dir <dir>] [--format json|md] [--out <file>]
// Validates the recommendations (same checks as recommend-check.js), then prints a deterministic migration plan skeleton.
// Never writes into the project; --out must be outside it. Exit 1: usage error, recommendation violations or plan integrity failure; 2: not a Gradle project or unreadable input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogError, loadCatalog, loadScoring } from './lib/catalog.js';
import { loadCatalogWithOverrides, oneLine } from './lib/overrides.js';
import { detectStack } from './lib/detect.js';
import { buildFeatureMap } from './lib/features.js';
import { churnByCommit } from './lib/git.js';
import { detectReuse } from './lib/reuse.js';
import { loadPlaybooks, validatePlaybooks, playbooksDir } from './lib/playbooks.js';
import { checkRecommendations } from './lib/guardrail.js';
import { loadAdrs } from './lib/adr.js';
import { buildPlan, checkPlan, renderRoadmap } from './lib/migplan.js';
import { redact, redactJson } from './lib/redact.js';

const USAGE = 'usage: node migration-plan.js <root> --recs <file> [--profile <file>] [--adr-dir <dir>] [--format json|md] [--out <file>]';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.xml'];

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}
const shown = (s) => redact(oneLine(s).slice(0, 200)).text;

function parseArgs(argv) {
  const opts = { root: null, recs: null, profile: null, adrDir: null, format: 'json', out: null };
  const valued = { '--recs': 'recs', '--profile': 'profile', '--adr-dir': 'adrDir', '--format': 'format', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in valued) {
      const v = argv[++i];
      if (v === undefined) fail(1, `missing value for ${a}\n${USAGE}`);
      opts[valued[a]] = v;
    } else if (a.startsWith('--')) fail(1, `unknown option ${shown(a)}\n${USAGE}`);
    else if (opts.root === null) opts.root = a;
    else fail(1, `unexpected argument ${shown(a)}\n${USAGE}`);
  }
  if (opts.root === null || opts.recs === null) fail(1, USAGE);
  if (opts.format !== 'json' && opts.format !== 'md') fail(1, `unknown format\n${USAGE}`);
  return opts;
}

/** Fail unless `out` resolves to a place outside the project (symlinks in its directory are resolved). */
function checkOut(out, root) {
  const abs = path.resolve(out);
  let dir;
  try {
    dir = fs.realpathSync(path.dirname(abs));
  } catch {
    fail(1, '--out directory does not exist');
  }
  const rel = path.relative(fs.realpathSync(root), path.join(dir, path.basename(abs)));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) fail(1, '--out must be outside the project');
  return abs;
}

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (err) {
    return fail(2, `cannot read ${what} ${shown(file)}: ${redact(oneLine(err.message).slice(0, 200)).text}`);
  }
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
  if (!isDir || !BUILD_FILES.some((f) => fs.existsSync(path.join(root, f)))) fail(2, `not an Android/Gradle project: ${shown(opts.root)}`);
  const outPath = opts.out === null ? null : checkOut(opts.out, root);
  const recs = readJson(opts.recs, 'recommendations');
  let profile = opts.profile === null ? null : readJson(opts.profile, 'profile');

  let adrs = [];
  const adrDir = opts.adrDir !== null ? path.resolve(opts.adrDir) : path.join(root, '.ai/knowledge/adr');
  if (opts.adrDir !== null || fs.existsSync(adrDir)) {
    try {
      adrs = loadAdrs(adrDir);
    } catch (err) {
      fail(2, `cannot read ADRs ${shown(adrDir)}: ${redact(oneLine(err.message).slice(0, 200)).text}`);
    }
  }

  let plan;
  try {
    const catalog = loadCatalogWithOverrides(undefined, root).catalog;
    profile = profile ?? detectStack(root, catalog);
    const result = checkRecommendations(recs, catalog, profile, { adrs });
    if (!result.ok) {
      process.stdout.write(redact(JSON.stringify(redactJson(result), null, 2)).text + '\n');
      process.exit(1);
    }
    const playbooks = loadPlaybooks(fileURLToPath(playbooksDir));
    const errs = validatePlaybooks(playbooks, loadCatalog());
    if (errs.length > 0) throw new Error(errs.slice(0, 5).join('; '));
    const features = buildFeatureMap(root, { profile: detectStack(root, catalog), scoring: loadScoring(), churn: churnByCommit(root) });
    plan = buildPlan({ recs, features, reuse: detectReuse(root), playbooks, profile, catalog });
    const problems = checkPlan(plan);
    if (problems.length > 0) throw new Error(`plan integrity check failed: ${problems.slice(0, 5).join('; ')}`);
  } catch (e) {
    if (e instanceof CatalogError || e instanceof Error) fail(1, redact(String(e.message)).text);
    throw e;
  }
  const text = opts.format === 'md' ? redact(renderRoadmap(plan)).text : JSON.stringify(redactJson(plan), null, 2) + '\n';
  if (outPath !== null) fs.writeFileSync(outPath, text);
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
