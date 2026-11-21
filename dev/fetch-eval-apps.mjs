#!/usr/bin/env node
// Maintainer-only: needs network and git. Not part of npm test and not packaged (package "files" is bin + skill).
// Usage: node dev/fetch-eval-apps.mjs [--proxy-env]
// Validates test/eval/apps.json, then clones each pinned commit into test/eval/apps/<id> and verifies HEAD equals the pin.
// Safety: https URLs only, hooks disabled, no repo script is ever run, sanitized environment. After checkout, JavaScript
// the working tree is reduced to an allowlist of files the scan reads (dev/lib/strip.mjs) because node's test discovery
// executes any js/ts file under test/. The sanitized environment drops proxy and CA variables; --proxy-env passes
// HTTPS_PROXY, https_proxy, NO_PROXY, no_proxy, SSL_CERT_FILE and GIT_SSL_CAINFO through for proxy-only networks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateApps } from './lib/apps-schema.mjs';
import { stripToAllowlist } from './lib/strip.mjs';

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

const proxyEnv = process.argv.includes('--proxy-env');
// Minimal environment: an EMPTY temporary HOME, no user git config, no credential helpers, no prompts, no LFS smudge.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fetch-home-'));
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
const env = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  LANG: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/bin/false',
  GIT_LFS_SKIP_SMUDGE: '1',
};
if (proxyEnv) {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO']) if (process.env[k]) env[k] = process.env[k];
}
const SAFE = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'core.fsmonitor=false',
  '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'credential.helper=',
  '-c', 'submodule.recurse=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false',
];
const git = (cwd, ...args) => execFileSync('git', [...SAFE, ...args], { cwd, env, encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });

const appsRoot = path.join(evalDir, 'apps');
fs.mkdirSync(appsRoot, { recursive: true });
const realAppsRoot = fs.realpathSync(appsRoot);
for (const app of manifest.apps) {
  const dest = path.join(appsRoot, app.id);
  if (fs.existsSync(dest) || fs.lstatSync(dest, { throwIfNoEntry: false })) {
    // An existing folder is never trusted: it must stay under test/eval/apps and still be at the pinned commit.
    let real;
    try {
      real = fs.realpathSync(dest);
      if (fs.lstatSync(dest).isSymbolicLink() || !real.startsWith(realAppsRoot + path.sep)) throw new Error('outside test/eval/apps');
      const head = git(real, 'rev-parse', 'HEAD').trim();
      if (head !== app.commit) throw new Error('HEAD does not match the pinned commit');
    } catch (err) {
      die(`${app.id}: existing test/eval/apps/${app.id} is not usable (${String(err.message).split('\n')[0]}); delete it and run again`);
    }
    stripToAllowlist(real);
    process.stdout.write(`${app.id}: already present at the pinned commit (re-stripped)\n`);
    continue;
  }
  process.stdout.write(`${app.id}: cloning ${app.repo} at ${app.commit}\n`);
  try {
    git(appsRoot, 'clone', '--no-checkout', '--', new URL(app.repo).href, app.id);
    git(dest, 'checkout', '--detach', app.commit);
    const head = git(dest, 'rev-parse', 'HEAD').trim();
    if (head !== app.commit) throw new Error(`HEAD ${head} does not match the pinned commit`);
    stripToAllowlist(dest);
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    die(`${app.id}: failed: ${String(err.message).split('\n')[0]}`);
  }
  process.stdout.write(`${app.id}: ok; next: node dev/record-eval.mjs ${app.id}\n`);
}
