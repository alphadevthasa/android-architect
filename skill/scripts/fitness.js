#!/usr/bin/env node
// Usage: node skill/scripts/fitness.js <projectRoot> [--check] [--out <dir>]
// Architecture fitness checks from the `fitness` rules of accepted ADRs (.ai/knowledge/adr).
// Default: prints the rules found (JSON) and writes the generated files into <root>/.ai/fitness through the guarded
// writer, or into --out <dir> (outside the project). --check: evaluates the rules statically, JSON on stdout.
// Exit codes: 0 ok (--check: no violation); 1 usage error, invalid ADR or rule, refused write, or violations (--check);
// 2 not a Gradle project, or no .ai folder (run init first). In a workspace member: a note, nothing written, exit 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAdrs } from './lib/adr.js';
import { writeGenerated } from './lib/aidir.js';
import { discoverModules } from './lib/modules.js';
import { listFiles } from './lib/walk.js';
import { parseFitnessRules, checkFitness, generateFitness, validModules, FITNESS_FILES } from './lib/fitness.js';
import { readManifest } from './lib/manifest.js';
import { oneLine } from './lib/overrides.js';
import { redact, redactJson } from './lib/redact.js';
import { safeOutPath, writeOut } from './lib/outpath.js';

const USAGE = 'usage: node fitness.js <projectRoot> [--check] [--out <dir>]';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];

// Line breaks, Unicode line separators and direction controls, removed from text echoed from ADR files.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const cleanText = (s) => oneLine(String(s).replace(UNSAFE_TEXT, ' ')).slice(0, 500);

function fail(code, message) {
  process.stderr.write(redact(message).text + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { root: null, check: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--out') {
      const v = argv[++i];
      if (v === undefined) fail(1, `missing value for --out\n${USAGE}`);
      opts.out = v;
    } else if (a.startsWith('--')) {
      fail(1, `unknown option ${oneLine(a).slice(0, 60)}\n${USAGE}`);
    } else if (opts.root === null) {
      opts.root = a;
    } else {
      fail(1, `unexpected argument\n${USAGE}`);
    }
  }
  if (opts.root === null) fail(1, USAGE);
  if (opts.check && opts.out !== null) fail(1, `--out writes generated files; it cannot be combined with --check\n${USAGE}`);
  return opts;
}

/** The --out directory, which must resolve outside the project (symlinks resolved); it is created when missing. */
function outDir(out, root) {
  const abs = path.resolve(out);
  let parent;
  try {
    parent = fs.realpathSync(path.dirname(abs));
  } catch {
    fail(1, '--out parent directory does not exist');
  }
  const rel = path.relative(fs.realpathSync(root), path.join(parent, path.basename(abs)));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) fail(1, '--out must be outside the project');
  return abs;
}

function writeOutDir(dir, files, root0) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    throw new Error('cannot create --out directory');
  }
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('refusing to write through a symlink: --out');
  // Every target is checked (links, hard links, non-regular files) before the first one is written.
  const targets = Object.keys(files).map((name) => {
    try {
      return [name, safeOutPath(path.join(dir, name), root0)];
    } catch (e) {
      throw new Error(`refusing to write ${name} in --out: ${e.message.replace(/^--out /, '')}`);
    }
  });
  const written = [];
  for (const [name, abs] of targets) {
    writeOut(abs, redact(files[name]).text);
    written.push(name);
  }
  return written.sort();
}

export function main(argv) {
  const opts = parseArgs(argv);
  const root = path.resolve(opts.root);
  const shown = oneLine(opts.root).slice(0, 200);
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir || !BUILD_FILES.some((f) => fs.existsSync(path.join(root, f)))) fail(2, `not a Gradle project: ${shown}`);
  let ai = null;
  try {
    ai = fs.lstatSync(path.join(root, '.ai'));
  } catch {
    ai = null;
  }
  if (ai !== null && ai.isSymbolicLink()) fail(1, 'refusing to use .ai: it is a symlink (symlinks are refused)');
  if (ai === null || !ai.isDirectory()) fail(2, `no .ai folder in ${shown}; run init first`);
  const memberNotes = [];
  try {
    if (readManifest(path.join(root, '.ai'))?.workspace?.role === 'member') {
      memberNotes.push('this repo is a workspace member: ADRs live in the hub; run fitness from the hub');
    }
  } catch {
    // an unreadable manifest only means no workspace note
  }
  // A workspace member has no ADRs of its own (they live in the hub): evaluate nothing, write nothing, exit 0.
  if (memberNotes.length) {
    const out = opts.check
      ? { ok: true, rules: 0, violations: [], notes: memberNotes, skippedFiles: 0, truncatedFiles: 0 }
      : { rules: [], notes: memberNotes, written: [], removed: [] };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  const outPath = opts.out === null ? null : outDir(opts.out, root);

  let parsed;
  try {
    const adrDir = path.join(root, '.ai', 'knowledge', 'adr');
    parsed = parseFitnessRules(fs.existsSync(adrDir) ? loadAdrs(adrDir) : []);
  } catch (e) {
    fail(1, cleanText(e.message));
  }
  if (parsed.errors.length) fail(1, parsed.errors.join('\n'));
  const { rules } = parsed;

  try {
    const files = listFiles(root, { gitignore: true });
    const modules = discoverModules(root, files);
    if (opts.check) {
      const result = checkFitness(root, rules, { files, modules });
      const out = {
        ok: result.ok, rules: rules.length, violations: result.violations, notes: [...memberNotes, ...parsed.notes, ...result.notes],
        skippedFiles: result.skippedFiles, truncatedFiles: result.truncatedFiles,
      };
      process.stdout.write(JSON.stringify(redactJson(out), null, 2) + '\n');
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    const generated = generateFitness(rules, modules);
    const { written, removed } = outPath === null
      ? writeGenerated(root, Object.fromEntries(Object.entries(generated).map(([n, t]) => [`fitness/${n}`, t])), {
        remove: FITNESS_FILES.map((n) => `fitness/${n}`),
      })
      : { written: writeOutDir(outPath, generated, root), removed: [] };
    const out = { rules, notes: [...memberNotes, ...parsed.notes, ...validModules(modules).notes], written, removed };
    process.stdout.write(JSON.stringify(redactJson(out), null, 2) + '\n');
  } catch (e) {
    fail(1, String(e.message));
  }
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
