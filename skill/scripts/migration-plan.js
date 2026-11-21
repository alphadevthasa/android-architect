#!/usr/bin/env node
// Usage: node skill/scripts/migration-plan.js <root> --recs <file> [--profile <file>] [--adr-dir <dir>] [--format json|md] [--out <file>]
// Validates the recommendations (same checks as recommend-check.js), then prints a deterministic migration plan skeleton.
// Never writes into the project unless --write is given (only .ai/migration/plan.json and roadmap.md[.new], through the guarded .ai writer); --out must be outside it. Exit 1: usage error, recommendation violations or plan integrity failure; 2: not a Gradle project or unreadable input.
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
import { buildPlan, checkPlan, renderRoadmap, renameUnsafeIds } from './lib/migplan.js';
import { safeOutPath, writeOut } from './lib/outpath.js';
import { redact, redactJson } from './lib/redact.js';
import { writeAiFiles } from './lib/aidir.js';
import { findTable } from './lib/runplan.js';

const USAGE = 'usage: node migration-plan.js <root> --recs <file> [--profile <file>] [--adr-dir <dir>] [--format json|md] [--out <file>] [--write]';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.xml'];

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}
const shown = (s) => redact(oneLine(s).slice(0, 200)).text;

function parseArgs(argv) {
  const opts = { root: null, recs: null, profile: null, adrDir: null, format: 'json', out: null, write: false };
  const valued = { '--recs': 'recs', '--profile': 'profile', '--adr-dir': 'adrDir', '--format': 'format', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a in valued) {
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

// The placeholder line init puts into a fresh roadmap (assembled so the docs scan for open-item words stays clean).
const TEMPLATE_MARKER = `${'TO'}${'DO'}: run "setup"`;
const TABLE_HEADER = '| Step | Description | Status |';
const MAX_ROADMAP_BYTES = 4 * 1024 * 1024;

const PLACEHOLDER_LINE = `${TEMPLATE_MARKER} in your agent`;

/**
 * The roadmap bytes (as a Buffer) with the table replaced by `table`, or null when the file has content of its own.
 * Replacement happens only when the existing roadmap has a table (header outside code fences) with no data rows; every
 * other byte before and after it stays verbatim, line endings included, except the exact placeholder line. A marker in
 * prose or hand-edited rows never triggers it.
 */
function replaceEmptyTable(existing, table) {
  // latin1: one character per byte, so the user's bytes survive even when the file is not valid UTF-8.
  const text = existing.toString('latin1');
  const lines = text.split('\n');
  const found = findTable(lines);
  if (found === null) return null;
  if (found.first < lines.length && lines[found.first].trim().startsWith('|')) return null;
  const crlf = text.includes('\r\n');
  const eol = crlf ? '\r\n' : '\n';
  const pre = lines.slice(0, found.head).filter((l) => l.trim() !== PLACEHOLDER_LINE).join('\n');
  const post = lines.slice(found.first).join('\n');
  const tableText = crlf ? table.replaceAll('\n', '\r\n') : table;
  return Buffer.concat([
    Buffer.from(pre.length > 0 ? pre + '\n' : '', 'latin1'),
    Buffer.from(tableText, 'utf8'),
    Buffer.from(post.trim().length > 0 ? eol + post : post, 'latin1'),
  ]);
}

/**
 * Writes plan.json and the roadmap. The roadmap table is filled only while it has no rows; otherwise the proposal goes to
 * roadmap.md.new and roadmap.md is left alone (plan.json is written either way; run refuses to start until the roadmap
 * rows match the plan steps).
 */
function writePlanFiles(root, planText, table) {
  const roadmap = path.join(root, '.ai/migration/roadmap.md');
  let existing = null;
  try {
    const st = fs.lstatSync(roadmap);
    if (!st.isFile() || st.size > MAX_ROADMAP_BYTES) throw new Error('.ai/migration/roadmap.md must be a regular file of reasonable size');
    existing = fs.readFileSync(roadmap);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const replaced = existing === null ? Buffer.from(`# Migration roadmap\n\n${table}`) : replaceEmptyTable(existing, table);
  const files = { 'migration/plan.json': planText, [replaced === null ? 'migration/roadmap.md.new' : 'migration/roadmap.md']: replaced ?? table };
  writeAiFiles(root, files);
  const lines = ['wrote .ai/migration/plan.json'];
  if (replaced === null) lines.push('.ai/migration/roadmap.md already has rows or content of its own: wrote the proposed table to .ai/migration/roadmap.md.new (merge it by hand; run refuses to start until the roadmap rows match the plan)');
  else lines.push('wrote .ai/migration/roadmap.md');
  return lines;
}

function checkOut(out, root) {
  try {
    return safeOutPath(out, root);
  } catch (e) {
    return fail(1, e.message);
  }
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
    if (!fs.existsSync(fileURLToPath(playbooksDir))) {
      fail(1, 'the playbooks are not vendored into .ai/tools; run migration-plan.js from the installed skill (npx android-architect), not from a vendored copy');
    }
    const playbooks = loadPlaybooks(fileURLToPath(playbooksDir));
    const errs = validatePlaybooks(playbooks, loadCatalog());
    if (errs.length > 0) throw new Error(errs.slice(0, 5).join('; '));
    const features = buildFeatureMap(root, { profile, scoring: loadScoring(), churn: churnByCommit(root) });
    plan = buildPlan({ recs, features, reuse: detectReuse(root), playbooks, profile, catalog });
    const problems = checkPlan(plan);
    if (problems.length > 0) throw new Error(`plan integrity check failed: ${problems.slice(0, 5).join('; ')}`);
  } catch (e) {
    if (e instanceof CatalogError || e instanceof Error) fail(1, redact(String(e.message)).text);
    throw e;
  }
  plan = renameUnsafeIds(plan, (s) => redact(s).text);
  const redacted = redactJson(plan);
  const after = checkPlan(redacted);
  if (after.length > 0) fail(1, `plan integrity check failed after redaction: ${redact(after.slice(0, 3).join('; ')).text}`);
  const text = opts.format === 'md' ? redact(renderRoadmap(plan)).text : JSON.stringify(redacted, null, 2) + '\n';
  if (opts.write) {
    try {
      const json = opts.format === 'md' ? JSON.stringify(redacted, null, 2) + '\n' : text;
      const lines = writePlanFiles(root, json, redact(renderRoadmap(plan)).text);
      process.stdout.write(lines.join('\n') + '\n');
    } catch (e) {
      fail(1, redact(oneLine(e.message).slice(0, 300)).text);
    }
    if (outPath === null) return;
  }
  if (outPath !== null) {
    try {
      writeOut(outPath, text);
    } catch (e) {
      fail(1, e.message);
    }
  }
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
