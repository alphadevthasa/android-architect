#!/usr/bin/env node
// Maintainer-only: needs network and git. Not part of npm test and not packaged (package "files" is bin + skill).
// Usage: node dev/fetch-eval-apps.mjs
// Validates test/eval/apps.json, then clones each pinned commit into test/eval/apps/<id> and verifies HEAD equals the pin.
// Safety: https URLs only, hooks disabled, no repo script is ever run, sanitized environment. After checkout, JavaScript
// files (.js/.mjs/.cjs) are removed from the working tree because node's test discovery executes any .js under test/.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateApps } from '../test/eval/apps-schema.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const evalDir = path.join(root, 'test', 'eval');
const die = (m) => { process.stderr.write(`${m}\n`); process.exit(1); };

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(evalDir, 'apps.json'), 'utf8'));
} catch (err) {
  die(`cannot read test/eval/apps.json: ${err.message}`);
}
const errors = validateApps(manifest);
if (errors.length > 0) die(`test/eval/apps.json is invalid:\n  ${errors.join('\n  ')}`);
if (manifest.apps.length === 0) {
  process.stdout.write('apps.json lists no apps; nothing to fetch (see test/eval/README.md to add one)\n');
  process.exit(0);
}

// Minimal environment: no user git config, no credential helpers, no prompts, no proxy or hook variables.
const env = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/bin/false',
};
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];
const git = (cwd, ...args) => execFileSync('git', [...SAFE, ...args], { cwd, env, encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });

function stripJs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) stripJs(p);
    else if (['.js', '.mjs', '.cjs'].includes(path.extname(e.name))) fs.rmSync(p);
  }
}

const appsRoot = path.join(evalDir, 'apps');
fs.mkdirSync(appsRoot, { recursive: true });
for (const app of manifest.apps) {
  const dest = path.join(appsRoot, app.id);
  if (fs.existsSync(dest)) {
    process.stdout.write(`${app.id}: already present, skipping (delete test/eval/apps/${app.id} to refetch)\n`);
    continue;
  }
  process.stdout.write(`${app.id}: cloning ${app.repo} at ${app.commit}\n`);
  try {
    git(appsRoot, 'clone', '--no-checkout', '--', app.repo, app.id);
    git(dest, 'checkout', '--detach', app.commit);
    const head = git(dest, 'rev-parse', 'HEAD').trim();
    if (head !== app.commit) throw new Error(`HEAD ${head} does not match the pinned commit`);
    stripJs(dest);
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    die(`${app.id}: failed: ${String(err.message).split('\n')[0]}`);
  }
  process.stdout.write(`${app.id}: ok; next: node dev/record-eval.mjs ${app.id}\n`);
}
