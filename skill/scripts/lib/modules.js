import fs from 'node:fs';
import path from 'node:path';
import { parseBuildFile, parseExtBlocks } from './gradle.js';
import { parseVersionCatalog } from './version-catalog.js';

function stripComments(text) {
  return String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:"'\\])\/\/.*$/gm, '$1');
}

function normalizePath(p) {
  const t = p.trim();
  return t.startsWith(':') ? t : ':' + t;
}

/**
 * Parse settings.gradle(.kts): `include` statements (several per line, several
 * lines) and `project(':x').projectDir = file(...)` overrides.
 * `kind` is accepted for symmetry with parseBuildFile; both syntaxes share one grammar here.
 */
export function parseSettings(text, kind) { // eslint-disable-line no-unused-vars
  const src = stripComments(text);
  const includes = [];
  const projectDirs = {};
  const incRe = /(?:^|[\s;])include(?!\w)\s*(\(([^)]*)\)|([^\n;]*))/g;
  for (const m of src.matchAll(incRe)) {
    const args = m[2] ?? m[3] ?? '';
    for (const s of args.matchAll(/["']([^"']+)["']/g)) {
      const p = normalizePath(s[1]);
      if (!includes.includes(p)) includes.push(p);
    }
  }
  const dirRe = /project\s*\(\s*["']([^"']+)["']\s*\)\s*\.projectDir\s*=\s*(?:new\s+)?(?:file|File)\s*\(\s*(?:(?:rootDir|settingsDir|rootProject\.projectDir)\s*,\s*)?["']([^"']+)["']/g;
  for (const m of src.matchAll(dirRe)) {
    projectDirs[normalizePath(m[1])] = m[2].replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  }
  return { includes, projectDirs };
}

function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function buildKind(rel) {
  return rel.endsWith('.kts') ? 'kts' : 'groovy';
}

function emptyBuild() {
  return { plugins: [], dependencies: [], android: { buildFeatures: {} }, ext: {} };
}

/**
 * Discover Gradle modules. Returns modules sorted by path.
 */
export function discoverModules(root, files) {
  const fileSet = new Set(files);
  const pick = (dir, base) => {
    const prefix = dir ? dir + '/' : '';
    for (const ext of ['.kts', '']) {
      const rel = `${prefix}${base}${ext}`;
      if (fileSet.has(rel)) return rel;
    }
    return null;
  };

  const settingsFile = pick('', 'settings.gradle');
  const settings = settingsFile ? parseSettings(readText(root, settingsFile) ?? '', buildKind(settingsFile)) : null;

  const ctx = {};
  const rootBuild = pick('', 'build.gradle');
  if (rootBuild) {
    const t = readText(root, rootBuild);
    if (t !== null) ctx.ext = parseExtBlocks(t);
  }
  if (fileSet.has('gradle/libs.versions.toml')) {
    const t = readText(root, 'gradle/libs.versions.toml');
    if (t !== null) ctx.versionCatalog = parseVersionCatalog(t);
  }

  const entries = settings
    ? settings.includes.map((p) => ({
        path: p,
        dir: settings.projectDirs[p] ?? p.slice(1).split(':').join('/'),
      }))
    : [{ path: ':', dir: '' }];

  const modules = entries.map(({ path: mpath, dir }) => {
    const buildFile = pick(dir, 'build.gradle');
    const kind = buildFile ? buildKind(buildFile) : 'groovy';
    const text = buildFile ? readText(root, buildFile) : null;
    const build = text === null ? emptyBuild() : parseBuildFile(text, kind, ctx);
    const projectDeps = [
      ...new Set(build.dependencies.filter((d) => d.project).map((d) => normalizePath(d.project))),
    ].sort();
    return { path: mpath, dir, buildFile, kind, build, projectDeps };
  });
  return modules.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function moduleGraph(modules) {
  const nodes = modules.map((m) => m.path);
  const edges = [];
  for (const m of modules) for (const to of m.projectDeps) edges.push([m.path, to]);
  return { nodes, edges };
}
