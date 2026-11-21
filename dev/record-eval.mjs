#!/usr/bin/env node
// Maintainer-only (not packaged, not part of npm test).
// Usage: node dev/record-eval.mjs <fixture-or-app-id> [--force]
// Runs skill/scripts/scan.js and candidates.js on test/fixtures/<name> (or test/eval/apps/<name>) and writes the golden
// to test/eval/golden/<name>.json (apps: golden/apps/<name>.json) for human review. It never overwrites without --force;
// with --force the existing hand-written "rules" are kept. Review the diff before committing; a catalog bump changes
// catalogVersion and derived entries, which is expected.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectProfile, projectCandidates } from '../test/eval/project.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node dev/record-eval.mjs <fixture-or-app-id> [--force]';
const die = (m) => { process.stderr.write(`${m}\n`); process.exit(1); };

const args = process.argv.slice(2);
const force = args.includes('--force');
const names = args.filter((a) => a !== '--force');
if (names.length !== 1 || names[0].startsWith('-')) die(USAGE);
const name = names[0];
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) die(`invalid name; ${USAGE}`);

const fixtureDir = path.join(root, 'test', 'fixtures', name);
const appDir = path.join(root, 'test', 'eval', 'apps', name);
let dir;
let golden;
if (fs.existsSync(fixtureDir)) {
  dir = fixtureDir;
  golden = path.join(root, 'test', 'eval', 'golden', `${name}.json`);
} else if (fs.existsSync(appDir)) {
  dir = appDir;
  golden = path.join(root, 'test', 'eval', 'golden', 'apps', `${name}.json`);
} else die(`no fixture test/fixtures/${name} and no fetched app test/eval/apps/${name}`);

if (fs.existsSync(golden) && !force) die(`${path.relative(root, golden)} exists; pass --force to overwrite (existing rules are kept)`);

const run = (script) => JSON.parse(execFileSync(process.execPath, [path.join(root, 'skill', 'scripts', script), dir], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20 }));
let rules = [];
if (fs.existsSync(golden)) rules = JSON.parse(fs.readFileSync(golden, 'utf8')).rules ?? [];
const out = { fixture: name, profile: projectProfile(run('scan.js')), candidates: projectCandidates(run('candidates.js')), rules };
fs.mkdirSync(path.dirname(golden), { recursive: true });
// Leaf arrays (ids, [id, share] pairs) stay on one line so the file reads as a table in a diff.
const text = JSON.stringify(out, null, 2).replace(/\[\n\s+([^[\]{}]*?)\n\s*\]/g, (_, inner) => `[${inner.split('\n').map((l) => l.trim()).join(' ')}]`);
fs.writeFileSync(golden, text + '\n');
process.stdout.write(`${golden}\n`);
