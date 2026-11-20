#!/usr/bin/env node
// Usage: node skill/scripts/lib-update.js <projectRoot> [--scope <module-path>] [--format json|md] [--out <file>]
// Plans library updates, security fixes first (read-only). Targets come from catalog/versions.json only.
// Test-only options: --today YYYY-MM-DD, --versions-dir <dir containing versions.json>.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogWithOverrides } from './lib/overrides.js';
import { loadVersions } from './lib/catalog.js';
import { collectBuildUnits } from './lib/detect.js';
import { planLibraryUpdates, renderLibraryUpdates } from './lib/libupdate.js';
import { oneLine } from './lib/overrides.js';
import { redact, redactJson } from './lib/redact.js';

const USAGE = 'usage: node lib-update.js <projectRoot> [--scope <module-path>] [--format json|md] [--out <file>]';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.xml'];
const MAX_LISTED_MODULES = 20;

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { root: null, format: 'json', out: null, scope: null, today: undefined, versionsDir: undefined };
  const valued = { '--format': 'format', '--out': 'out', '--scope': 'scope', '--today': 'today', '--versions-dir': 'versionsDir' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a in valued) {
      const v = argv[++i];
      if (v === undefined) fail(1, `missing value for ${a}\n${USAGE}`);
      opts[valued[a]] = v;
    } else if (a.startsWith('--')) {
      fail(1, `unknown option ${redact(oneLine(a).slice(0, 60)).text}\n${USAGE}`);
    } else if (opts.root === null) {
      opts.root = a;
    } else {
      fail(1, `unexpected argument\n${USAGE}`);
    }
  }
  if (opts.root === null) fail(1, USAGE);
  if (opts.format !== 'json' && opts.format !== 'md') fail(1, `unknown format\n${USAGE}`);
  if (opts.today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.today)) fail(1, `--today must be YYYY-MM-DD\n${USAGE}`);
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

export function main(argv) {
  const opts = parseArgs(argv);
  const root = path.resolve(opts.root);
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir || !BUILD_FILES.some((f) => fs.existsSync(path.join(root, f)))) fail(2, `not an Android/Gradle project: ${redact(oneLine(opts.root).slice(0, 200)).text}`);
  const outPath = opts.out === null ? null : checkOut(opts.out, root);
  let plan;
  try {
    const catalog = loadCatalogWithOverrides(undefined, root).catalog;
    const versions = loadVersions(opts.versionsDir);
    const { units, modules } = collectBuildUnits(root);
    let scope;
    if (opts.scope !== null) {
      scope = opts.scope.startsWith(':') ? opts.scope : ':' + opts.scope;
      if (!modules.some((m) => m.path === scope)) {
        const known = modules.slice(0, MAX_LISTED_MODULES).map((m) => m.path).join('\n');
        throw new Error(`unknown module ${redact(oneLine(opts.scope).slice(0, 100)).text}\nknown modules:\n${known}${modules.length > MAX_LISTED_MODULES ? `\n... and ${modules.length - MAX_LISTED_MODULES} more` : ''}`);
      }
    }
    plan = planLibraryUpdates({ catalogVersion: catalog.catalogVersion }, modules, catalog, versions, { today: opts.today, units, scope });
  } catch (e) {
    fail(1, redact(String(e.message)).text);
  }
  const text = opts.format === 'md' ? redact(renderLibraryUpdates(plan)).text : JSON.stringify(redactJson(plan), null, 2) + '\n';
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
