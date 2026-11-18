import fs from 'node:fs';
import path from 'node:path';
import { listFiles, readLines } from './walk.js';
import { discoverModules } from './modules.js';
import { globToRegExp } from './glob.js';

export const PROFILE_SCHEMA_VERSION = 1;
const MAX_EVIDENCE = 5;
const MAX_READ_BYTES = 1024 * 1024;
const READABLE_EXT = new Set(['.java', '.kt', '.kts', '.gradle', '.xml', '.toml', '.properties', '.pro']);
const SOURCE_EXT = new Set(['.java', '.kt']);
const LAYOUT_RE = globToRegExp('**/res/layout*/*.xml');
const MANIFEST_RE = globToRegExp('**/AndroidManifest.xml');
const IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.]+)/;
const KAPT_PLUGINS = new Set(['kotlin-kapt', 'org.jetbrains.kotlin.kapt']);
const LAYER_NAMES = new Set(['data', 'domain', 'presentation']);
// Computed entries not handled by evaluateComputed() are not evaluated in M1
// and never emitted. Compliance is reported separately in profile.compliance.
const COMPLIANCE_DIM = 'compliance';

const extOf = (rel) => path.posix.extname(rel).toLowerCase();

/** Lazily read and cache file lines; only readable text files up to 1 MB. */
function makeReader(root) {
  const cache = new Map();
  return (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let lines = null;
    if (READABLE_EXT.has(extOf(rel))) {
      try {
        const abs = path.join(root, rel);
        if (fs.statSync(abs).size <= MAX_READ_BYTES) lines = readLines(abs);
      } catch {
        lines = null;
      }
    }
    cache.set(rel, lines);
    return lines;
  };
}

/** Compare dotted versions numerically, ignoring qualifiers (`2.0.21-1.0.28` -> 2.0.21). */
export function compareVersions(a, b) {
  const parse = (v) => String(v).split(/[-+]/)[0].split('.').map((s) => parseInt(s, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function coordMatches(coord, dep) {
  if (!dep.group || !dep.name) return false;
  const idx = coord.indexOf(':');
  const group = coord.slice(0, idx);
  const name = coord.slice(idx + 1);
  if (dep.group !== group) return false;
  return name === '' || dep.name === name;
}

function satisfiesMin(version, min) {
  if (!min) return true;
  if (version === null || version === undefined) return false;
  return compareVersions(version, min) >= 0;
}

/**
 * Gradle build units: every discovered module, plus the root build file when
 * it is not itself a module (a settings-based build), so root `classpath` and
 * `plugins { ... apply false }` rows are visible too.
 */
function buildUnits(root, modules, files, read) {
  const units = modules.filter((m) => m.buildFile).map((m) => ({ key: m.buildFile, file: m.buildFile, build: m.build }));
  const covered = new Set(units.map((u) => u.file));
  for (const rel of ['build.gradle.kts', 'build.gradle']) {
    if (files.includes(rel) && !covered.has(rel)) {
      const lines = read(rel);
      if (lines) {
        // Without a settings file, discoverModules parses `rel` as the root module.
        const scope = files.filter((f) => f === rel || f === 'gradle/libs.versions.toml');
        const m = discoverModules(root, scope).find((x) => x.buildFile === rel);
        if (m) units.push({ key: rel, file: rel, build: m.build });
      }
      break;
    }
  }
  // A plugin declared with `apply false` is not applied to that build.
  for (const u of units) {
    const lines = read(u.file) ?? [];
    u.appliedPlugins = u.build.plugins.filter((p) => !/\bapply\s*\(?\s*false\b/.test(lines[p.line - 1] ?? ''));
  }
  return units;
}

function addEvidence(acc, unitKey, kind, ev) {
  if (!acc.units.has(kind)) acc.units.set(kind, new Set());
  acc.units.get(kind).add(unitKey);
  acc.evidence.push(ev);
}

function evaluateEntry(entry, ctx) {
  const d = entry.detect;
  // Units: a module (build file) for gradle/plugins signals, a file for
  // imports/content/files/manifest signals.
  const acc = { units: new Map(), evidence: [] };
  for (const g of d.gradle ?? []) {
    for (const u of ctx.buildUnits) {
      for (const dep of u.build.dependencies) {
        if (coordMatches(g.coord, dep) && satisfiesMin(dep.version, g.minVersion)) {
          addEvidence(acc, u.key, 'module', { file: u.file, line: dep.line, signal: `gradle ${g.coord}` });
        }
      }
    }
  }
  for (const id of d.plugins ?? []) {
    for (const u of ctx.buildUnits) {
      for (const p of u.appliedPlugins) {
        if (p.id === id) addEvidence(acc, u.key, 'module', { file: u.file, line: p.line, signal: `plugin ${id}` });
      }
    }
  }
  for (const prefix of d.imports ?? []) {
    for (const f of ctx.sourceFiles) {
      const lines = ctx.read(f);
      if (!lines) continue;
      lines.forEach((text, i) => {
        const m = IMPORT_RE.exec(text);
        if (m && m[1].startsWith(prefix)) addEvidence(acc, f, 'file', { file: f, line: i + 1, signal: `import ${prefix}` });
      });
    }
  }
  for (const glob of d.files ?? []) {
    const re = ctx.glob(glob);
    for (const f of ctx.files) {
      // File-existence signals have no specific line.
      if (re.test(f)) addEvidence(acc, f, 'file', { file: f, line: null, signal: `file ${glob}` });
    }
  }
  for (const c of d.content ?? []) {
    const re = ctx.glob(c.glob);
    // Tested per line, no flags: ^/$ anchor to the line.
    const rx = new RegExp(c.regex);
    for (const f of ctx.files) {
      if (!re.test(f)) continue;
      const lines = ctx.read(f);
      if (!lines) continue;
      lines.forEach((text, i) => {
        if (rx.test(text)) addEvidence(acc, f, 'file', { file: f, line: i + 1, signal: `content ${c.regex}` });
      });
    }
  }
  for (const s of d.manifest ?? []) {
    for (const f of ctx.manifests) {
      const lines = ctx.read(f);
      if (!lines) continue;
      lines.forEach((text, i) => {
        if (text.includes(s)) addEvidence(acc, f, 'file', { file: f, line: i + 1, signal: `manifest ${s}` });
      });
    }
  }
  return acc;
}

function moduleSegments(m) {
  return m.path.split(':').filter(Boolean);
}

/** Computed entries evaluated in M1. Returns an accumulator, or null if not evaluated. */
function evaluateComputed(dimId, entryId, ctx) {
  const acc = { units: new Map(), evidence: [] };
  const key = `${dimId}.${entryId}`;
  const modEv = (m, signal) => ({ file: m.buildFile ?? 'settings.gradle', line: null, signal });
  if (dimId === 'modularization') {
    const mods = ctx.modules;
    if (entryId === 'single-module') {
      if (mods.length === 1) addEvidence(acc, mods[0].path, 'module', modEv(mods[0], 'computed single module'));
    } else if (entryId === 'layer-modules') {
      for (const m of mods) {
        if (moduleSegments(m).some((s) => LAYER_NAMES.has(s))) addEvidence(acc, m.path, 'module', modEv(m, `computed layer module ${m.path}`));
      }
    } else if (entryId === 'feature-modules') {
      for (const m of mods) {
        if (moduleSegments(m).includes('feature')) addEvidence(acc, m.path, 'module', modEv(m, `computed feature module ${m.path}`));
      }
    } else if (entryId === 'api-impl-modules') {
      const paths = new Set(mods.map((m) => m.path));
      for (const m of mods) {
        const segs = moduleSegments(m);
        const last = segs[segs.length - 1];
        if (last !== 'api' && last !== 'impl') continue;
        const other = ':' + [...segs.slice(0, -1), last === 'api' ? 'impl' : 'api'].join(':');
        if (paths.has(other)) addEvidence(acc, m.path, 'module', modEv(m, `computed api/impl pair ${m.path}`));
      }
    } else {
      return null;
    }
    return acc;
  }
  if (key === 'language.kotlin-k2') {
    for (const u of ctx.buildUnits) {
      for (const p of u.build.plugins) {
        if (p.id.startsWith('org.jetbrains.kotlin') && p.version && compareVersions(p.version, '2.0') >= 0) {
          addEvidence(acc, u.key, 'module', { file: u.file, line: p.line, signal: `kotlin plugin ${p.version}` });
        }
      }
      for (const dep of u.build.dependencies) {
        if (dep.group === 'org.jetbrains.kotlin' && dep.version && compareVersions(dep.version, '2.0') >= 0) {
          addEvidence(acc, u.key, 'module', { file: u.file, line: dep.line, signal: `kotlin ${dep.version}` });
        }
      }
    }
    return acc;
  }
  if (key === 'navigation.multi-activity') {
    for (const f of ctx.manifests) {
      const lines = ctx.read(f);
      if (!lines) continue;
      const hits = [];
      lines.forEach((text, i) => {
        if (/<activity\b/.test(text)) hits.push(i + 1);
      });
      if (hits.length >= 3) for (const line of hits) addEvidence(acc, f, 'file', { file: f, line, signal: 'manifest <activity>' });
    }
    return acc;
  }
  if (key === 'build-performance.kapt-free') {
    const usesKapt = ctx.buildUnits.some(
      (u) => u.appliedPlugins.some((p) => KAPT_PLUGINS.has(p.id)) || u.build.dependencies.some((d) => /^kapt/.test(d.configuration ?? '')),
    );
    if (!usesKapt) for (const u of ctx.buildUnits) addEvidence(acc, u.key, 'module', { file: u.file, line: null, signal: 'computed no kapt' });
    return acc;
  }
  return null;
}

/**
 * Units for one entry. If an entry matched through both file-level signals
 * (imports/content/files/manifest) and module-level signals (gradle/plugins/
 * computed), file units are counted when there are any, else module units.
 * This keeps shares deterministic and avoids adding apples to oranges inside
 * one entry. Evidence from all signals is kept.
 */
function unitCount(acc) {
  const files = acc.units.get('file')?.size ?? 0;
  return files > 0 ? files : acc.units.get('module')?.size ?? 0;
}

function sortEvidence(evidence) {
  const seen = new Set();
  return evidence
    .filter((e) => {
      const k = `${e.file}\0${e.line}\0${e.signal}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0)))
    .slice(0, MAX_EVIDENCE);
}

function sdkSummary(modules) {
  const pick = (field, fn) => {
    const vals = modules.map((m) => m.build.android?.[field]).filter((v) => typeof v === 'number');
    return vals.length ? fn(...vals) : null;
  };
  return { minSdk: pick('minSdk', Math.min), targetSdk: pick('targetSdk', Math.max), compileSdk: pick('compileSdk', Math.max) };
}

function sizeSummary(files, read) {
  const size = { files: files.length, sourceFiles: 0, kotlinFiles: 0, javaFiles: 0, xmlLayouts: 0, loc: 0 };
  for (const f of files) {
    const ext = extOf(f);
    if (LAYOUT_RE.test(f)) size.xmlLayouts++;
    if (!SOURCE_EXT.has(ext)) continue;
    size.sourceFiles++;
    if (ext === '.kt') size.kotlinFiles++;
    else size.javaFiles++;
    const lines = read(f);
    if (lines) size.loc += lines.filter((l) => l.trim() !== '').length;
  }
  return size;
}

function evaluateCompliance(sdk) {
  const out = [];
  if (sdk.targetSdk !== null) {
    out.push({
      id: 'target-sdk-35',
      status: sdk.targetSdk >= 35 ? 'ok' : 'gap',
      detail: `max targetSdk is ${sdk.targetSdk}; Google Play requires 35`,
    });
  }
  return out;
}

/** Map an Android project onto every catalog dimension. */
export function detectStack(root, catalog) {
  const files = listFiles(root);
  const read = makeReader(root);
  const modules = discoverModules(root, files);
  const globCache = new Map();
  const ctx = {
    files,
    read,
    modules,
    sourceFiles: files.filter((f) => SOURCE_EXT.has(extOf(f))),
    manifests: files.filter((f) => MANIFEST_RE.test(f)),
    buildUnits: buildUnits(root, modules, files, read),
    glob: (g) => {
      if (!globCache.has(g)) globCache.set(g, globToRegExp(g));
      return globCache.get(g);
    },
  };

  const sdk = sdkSummary(modules);
  const dimensions = {};
  for (const dim of catalog.dimensions) {
    if (dim.id === COMPLIANCE_DIM) continue; // reported in profile.compliance
    const rows = [];
    for (const entry of dim.entries) {
      const acc = entry.detect.computed ? evaluateComputed(dim.id, entry.id, ctx) : evaluateEntry(entry, ctx);
      if (!acc) continue;
      const units = unitCount(acc);
      if (units > 0) rows.push({ id: entry.id, units, evidence: sortEvidence(acc.evidence) });
    }
    const total = rows.reduce((s, r) => s + r.units, 0);
    const entries = rows
      .map((r) => ({ id: r.id, share: Math.round((r.units / total) * 100) / 100, units: r.units, evidence: r.evidence }))
      .sort((a, b) => b.share - a.share || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    dimensions[dim.id] = { entries };
  }

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    catalogVersion: catalog.catalogVersion,
    root: '.',
    sdk,
    size: sizeSummary(files, read),
    modules: modules.map((m) => ({ path: m.path, dir: m.dir, projectDeps: m.projectDeps })),
    dimensions,
    compliance: evaluateCompliance(sdk),
  };
}
