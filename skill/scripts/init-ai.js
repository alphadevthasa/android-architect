#!/usr/bin/env node
// Usage: node init-ai.js <root> [--local] [--append-pointers] [--workspace [path ...]]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAiDir } from './lib/aidir.js';
import { gitDir } from './lib/git.js';
import { siblingRepos, linkWorkspace } from './lib/workspace.js';

const USAGE = 'usage: node init-ai.js <root> [--local] [--append-pointers] [--workspace [path ...]]';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { root: null, local: false, appendPointers: false, workspace: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') opts.local = true;
    else if (a === '--append-pointers') opts.appendPointers = true;
    else if (a === '--workspace') {
      opts.workspace = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.workspace.push(argv[++i]);
    } else if (a.startsWith('--')) fail(1, `unknown option ${a}\n${USAGE}`);
    else if (opts.root === null) opts.root = a;
    else fail(1, `unexpected argument ${a}\n${USAGE}`);
  }
  if (opts.root === null) fail(1, USAGE);
  return opts;
}

const inside = (parent, p) => p === parent || p.startsWith(parent + path.sep);

/** Validate every workspace repo before anything is written. Relative paths resolve against the hub. */
function planWorkspace(root, opts) {
  const hub = fs.realpathSync(root);
  if (opts.local && !gitDir(root)) throw new Error('--local needs a git repository');
  const confirmed = opts.workspace.length > 0;
  const given = confirmed ? opts.workspace : siblingRepos(hub);
  if (!given.length) throw new Error('no sibling Gradle repos found; pass repo paths to --workspace');
  const members = [];
  for (const p of given) {
    let abs;
    try {
      abs = fs.realpathSync(path.resolve(hub, p));
    } catch {
      throw new Error(`workspace path does not exist: ${p}`);
    }
    if (!fs.statSync(abs).isDirectory()) throw new Error(`workspace path is not a directory: ${p}`);
    if (!BUILD_FILES.some((f) => fs.existsSync(path.join(abs, f)))) throw new Error(`workspace path has no Gradle build files: ${p}`);
    if (inside(hub, abs) || inside(abs, hub)) throw new Error(`workspace path must be outside the hub and must not contain it: ${p}`);
    if (members.some((m) => m.abs === abs)) throw new Error(`workspace path listed twice: ${p}`);
    if (path.basename(abs) === path.basename(hub) || members.some((m) => m.name === path.basename(abs))) throw new Error(`workspace repos need distinct names: ${path.basename(abs)}`);
    if (opts.local && !gitDir(abs)) throw new Error(`--local needs a git repository: ${p}`);
    members.push({
      abs,
      name: path.basename(abs),
      hubRel: path.relative(abs, hub).split(path.sep).join('/'),
    });
  }
  return { members, repos: linkWorkspace(hub, members.map((m) => m.abs), { confirmed }) };
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
  const now = new Date();
  const base = { now, local: opts.local, appendPointers: opts.appendPointers };
  let result;
  try {
    if (opts.workspace === null) result = writeAiDir(root, base);
    else {
      const plan = planWorkspace(root, opts);
      const hub = writeAiDir(root, { ...base, workspace: { role: 'hub', hub: '.' }, repos: plan.repos });
      const members = {};
      for (const m of plan.members) {
        members[m.name] = writeAiDir(m.abs, { ...base, workspace: { role: 'member', hub: m.hubRel } });
      }
      result = { hub, members, repos: plan.repos };
    }
  } catch (e) {
    fail(1, e.message);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
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
