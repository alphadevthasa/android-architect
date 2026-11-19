// Re-generates the .ai folder and reports what changed: catalog, candidates, recommendations, rejections.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './catalog.js';
import { baseVersion, oneLine } from './overrides.js';
import { detectStack } from './detect.js';
import { candidatePaths } from './candidates.js';
import { checkRecommendations } from './guardrail.js';
import { loadAdrs, activeRejections, adrWarnings } from './adr.js';
import { MANIFEST_SCHEMA_VERSION, readManifest } from './manifest.js';
import { writeAiDir, preflight, resolveToolVersion } from './aidir.js';
import { generatedHeader } from './knowledge.js';
import { scanAiDir } from './injection.js';
import { verifyTools, selfCheckTools } from './integrity.js';

const DEFAULT_SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Layout migrations keyed by the schema they upgrade from. Only schema 1 exists, so there are none yet.
const MIGRATIONS = {};

const stamp = (now) => now.toISOString().replace(/\D/g, '').slice(0, 14);

/** Bring an older .ai layout up to the current schema, after copying .ai to .ai.backup-<stamp>. Returns the backup path or null. */
export function migrateLayout(aiDir, fromSchema, now = new Date()) {
  if (fromSchema === MANIFEST_SCHEMA_VERSION) return null;
  const steps = MIGRATIONS[fromSchema];
  if (!steps) throw new Error(`unknown .ai layout schema ${fromSchema}; cannot migrate`);
  const backup = `${aiDir}.backup-${stamp(now)}`;
  fs.cpSync(aiDir, backup, { recursive: true });
  for (const step of steps) step(aiDir);
  return backup;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function candidateIds(entry) {
  return new Set([...(entry?.next ?? []), ...(entry?.reachable ?? [])]);
}

function diffCandidates(oldCands, newCands) {
  const out = {};
  for (const dim of [...new Set([...Object.keys(oldCands), ...Object.keys(newCands)])].sort(byText)) {
    const before = candidateIds(oldCands[dim]);
    const after = candidateIds(newCands[dim]);
    const added = [...after].filter((id) => !before.has(id)).sort(byText);
    const removed = [...before].filter((id) => !after.has(id)).sort(byText);
    if (added.length || removed.length) out[dim] = { added, removed };
  }
  return out;
}

function tryLoadCatalog(dir) {
  try {
    return loadCatalog(dir);
  } catch {
    return null;
  }
}

function diffRecommendations(recs, oldCatalog, newCatalog, newBase, profile, adrs, notes) {
  const checked = recs !== null && typeof recs === 'object' && !Array.isArray(recs);
  if (checked && recs.catalogVersion !== baseVersion(newCatalog) && recs.catalogVersion !== newCatalog.catalogVersion) {
    notes.push(`recommendations.json was written for catalog ${recs.catalogVersion}; checked against ${baseVersion(newCatalog)}`);
  }
  const violations = checkRecommendations(
    checked ? { ...recs, catalogVersion: baseVersion(newCatalog) } : recs,
    newCatalog,
    profile,
    { adrs },
  ).violations;
  const statusChanges = [];
  const newOptions = [];
  if (checked && oldCatalog) {
    const refs = new Map();
    const add = (dimension, id) => {
      if (typeof dimension === 'string' && typeof id === 'string') refs.set(`${dimension}\0${id}`, { dimension, id });
    };
    for (const d of Array.isArray(recs.dimensions) ? recs.dimensions : []) add(d?.dimension, d?.target);
    for (const s of Array.isArray(recs.steps) ? recs.steps : []) add(s?.dimension, s?.to);
    for (const { dimension, id } of [...refs.values()].sort((a, b) => byText(`${a.dimension}/${a.id}`, `${b.dimension}/${b.id}`))) {
      const before = oldCatalog.entry(dimension, id);
      const after = newBase.entry(dimension, id);
      if (!before) continue;
      const to = after ? after.status : 'removed';
      if (before.status !== to) statusChanges.push({ dimension, id, from: before.status, to });
    }
    const targets = new Map();
    for (const d of Array.isArray(recs.dimensions) ? recs.dimensions : []) {
      if (typeof d?.dimension === 'string' && typeof d?.target === 'string') targets.set(`${d.dimension}\0${d.target}`, d);
    }
    for (const d of [...targets.values()].sort((a, b) => byText(`${a.dimension}/${a.target}`, `${b.dimension}/${b.target}`))) {
      const before = new Set(oldCatalog.entry(d.dimension, d.target)?.successors ?? []);
      const successors = (newBase.entry(d.dimension, d.target)?.successors ?? []).filter((s) => !before.has(s));
      if (successors.length && oldCatalog.entry(d.dimension, d.target)) newOptions.push({ dimension: d.dimension, target: d.target, successors });
    }
  }
  return { violations, statusChanges, newOptions };
}

/** Pins and added entries compared with the previous manifest (absent fields count as none). */
function diffOverrides(manifest, catalog) {
  const prevPins = manifest.overridePins ?? {};
  const prevAdded = new Set(manifest.overrideAdded ?? []);
  const o = catalog.overridden ?? { added: [], pins: {} };
  const pins = Object.fromEntries(Object.entries(o.pins ?? {}).map(([k, v]) => [k, v.status]));
  const keys = (obj) => Object.keys(obj).sort(byText);
  return {
    pinsAdded: keys(pins).filter((k) => !(k in prevPins)).map((k) => ({ entry: k, status: pins[k] })),
    pinsRemoved: keys(prevPins).filter((k) => !(k in pins)).map((k) => ({ entry: k, status: prevPins[k] })),
    pinsChanged: keys(pins).filter((k) => k in prevPins && prevPins[k] !== pins[k]).map((k) => ({ entry: k, from: prevPins[k], to: pins[k] })),
    entriesAdded: o.added.filter((id) => !prevAdded.has(id)).sort(byText),
    entriesRemoved: [...prevAdded].filter((id) => !o.added.includes(id)).sort(byText),
    active: {
      pins: keys(pins).map((k) => ({ entry: k, status: pins[k], reason: o.pins[k].reason })),
      entries: [...o.added].sort(byText),
    },
  };
}

function renderReport(report, meta) {
  const list = (items, empty = '- none') => (items.length ? items.map((i) => `- ${i}`) : [empty]);
  const lines = [generatedHeader(meta), '', '# Refresh report', ''];
  lines.push('## Catalog', '', `- Tool: ${report.tool.from} -> ${report.tool.to}`, `- Catalog: ${report.catalog.from} -> ${report.catalog.to}`, '');
  lines.push('## Candidates', '');
  const dims = Object.keys(report.candidates);
  if (!dims.length) lines.push('- no changes');
  for (const dim of dims) {
    const { added, removed } = report.candidates[dim];
    lines.push(`- ${dim}: added [${added.join(', ')}]; removed [${removed.join(', ')}]`);
  }
  lines.push('', '## Recommendations', '');
  if (report.recommendations === null) lines.push('- no .ai/recommendations.json');
  else {
    const r = report.recommendations;
    lines.push(`- Violations: ${r.violations.length}`, ...r.violations.map((v) => `  - ${v.rule}: ${v.message}`));
    lines.push(`- Status changes: ${r.statusChanges.length}`, ...r.statusChanges.map((c) => `  - ${c.dimension}.${c.id}: ${c.from} -> ${c.to}`));
    lines.push(`- New options: ${r.newOptions.length}`, ...r.newOptions.map((o) => `  - ${o.dimension}.${o.target}: new successors [${o.successors.join(', ')}]`));
  }
  const ov = report.overrides;
  lines.push('', '## Catalog overrides', '');
  lines.push(`- Files: ${report.overrideFiles.length ? report.overrideFiles.join(', ') : 'none'}`);
  lines.push(`- Active pins: ${ov.active.pins.length}`, ...ov.active.pins.map((p) => `  - ${p.entry}: ${p.status} (reason: ${oneLine(p.reason)})`));
  lines.push(`- Added entries: ${ov.active.entries.length}`, ...ov.active.entries.map((e) => `  - ${e}`));
  lines.push('- Changes since the last run:');
  const changes = [
    ...ov.pinsAdded.map((p) => `pin added: ${p.entry} -> ${p.status}`),
    ...ov.pinsRemoved.map((p) => `pin removed: ${p.entry} (was ${p.status})`),
    ...ov.pinsChanged.map((p) => `pin changed: ${p.entry} ${p.from} -> ${p.to}`),
    ...ov.entriesAdded.map((e) => `entry added: ${e}`),
    ...ov.entriesRemoved.map((e) => `entry removed: ${e}`),
  ];
  lines.push(...(changes.length ? changes.map((c) => `  - ${c}`) : ['  - none']));
  lines.push('', '## Rejections', '');
  lines.push(...list(report.rejections.reopened.map((r) => `${r.dimension}.${r.target} can be reopened (${r.condition}), see ${r.adr.file}`), '- no reopened rejections'));
  lines.push('', '## Files', '');
  lines.push(`- Written: ${report.files.written.length}`, `- Kept (user-owned): ${report.files.kept.length}`, ...report.files.kept.map((f) => `  - ${f}`));
  lines.push(`- Conflicts: ${report.files.conflicts.length}`, ...report.files.conflicts.map((f) => `  - ${f} (see the .new file next to it)`));
  lines.push('', '## Notes', '', ...list(report.notes), '');
  return lines.join('\n');
}

/**
 * Refresh rewrites .ai/tools, so a modified copy does not block it; it only reports what was modified before the rewrite.
 * Against this skill when the versions match, else (weaker) against manifest.json.
 */
function modifiedToolsNotes(root, aiDir, opts) {
  let check = verifyTools(root, opts);
  let against = 'the running android-architect';
  if (check.status === 'unverifiable') {
    check = selfCheckTools(aiDir);
    against = '.ai/manifest.json';
  }
  if (check.status !== 'modified') return [];
  const files = [...check.changed, ...check.added, ...check.removed].sort(byText);
  const detail = files.length ? `: ${files.join(', ')}` : check.reason ? ` (${check.reason})` : '';
  return [`.ai/tools differed from ${against} before this refresh and was rewritten${detail}`];
}

/**
 * Regenerate .ai (same ownership rules as init) and diff against what was there before.
 * Keeps the project's mode and workspace role. A hub refresh does not touch members: run refresh per repo.
 */
export function refreshAiDir(root, { now = new Date(), catalogDir, skillDir = DEFAULT_SKILL_DIR, toolVersion } = {}) {
  const aiDir = path.join(root, '.ai');
  catalogDir = catalogDir ?? path.join(skillDir, 'catalog');
  const manifest = readManifest(aiDir);
  if (manifest === null) {
    throw Object.assign(new Error('no .ai/manifest.json: run init first'), { code: 'NO_MANIFEST' });
  }
  const local = manifest.mode === 'local';
  const workspace = manifest.workspace ?? null;
  const isMember = workspace?.role === 'member';
  const loaded = preflight(root, { local, catalogDir });
  migrateLayout(aiDir, manifest.schemaVersion, now);

  const notes = [];
  const oldCatalog = tryLoadCatalog(path.join(aiDir, 'tools', 'catalog'));
  const oldSnapshot = readJson(path.join(aiDir, 'candidates.json'));
  const oldCands = oldSnapshot?.candidates ?? {};
  if (!oldCatalog) notes.push('the previous catalog could not be read from .ai/tools/catalog; status and new-option diffs are empty');
  if (!oldSnapshot?.candidates) notes.push('the previous .ai/candidates.json could not be read; candidate diff is empty');

  // New side = base + project overrides for detection and the guardrail. Status changes and new options compare the old
  // vendored base with the new BASE, so pins never appear there; they are reported under `overrides`, diffed against the
  // previous manifest.
  const newCatalog = loaded.catalog;
  const newBase = loaded.base;
  if (manifest.catalogVersion !== baseVersion(newCatalog)) {
    notes.push(`catalog moved from ${manifest.catalogVersion} to ${baseVersion(newCatalog)}; re-check recommendations.json and architecture-target.md`);
  }
  const profile = detectStack(root, newCatalog);
  const newCands = candidatePaths(profile, newCatalog);
  const candidates = oldSnapshot?.candidates ? diffCandidates(oldCands, newCands) : {};

  let recommendations = null;
  let rejections = { reopened: [] };
  if (!isMember) {
    const adrDir = path.join(aiDir, 'knowledge', 'adr');
    const adrs = fs.existsSync(adrDir) ? loadAdrs(adrDir) : [];
    rejections = { reopened: activeRejections(adrs, profile).reopened };
    notes.push(...adrWarnings(adrs, newCatalog));
    const recFile = path.join(aiDir, 'recommendations.json');
    if (fs.existsSync(recFile)) {
      const recs = readJson(recFile);
      if (recs === null) notes.push('.ai/recommendations.json is not valid JSON');
      recommendations = diffRecommendations(recs, oldCatalog, newCatalog, newBase, profile, adrs, notes);
    }
  }

  const toolTo = toolVersion ?? resolveToolVersion(skillDir, aiDir);
  notes.push(...modifiedToolsNotes(root, aiDir, { skillDir, catalogDir, toolVersion: toolTo }));
  const report = {
    tool: { from: manifest.toolVersion ?? null, to: toolTo },
    catalog: { from: manifest.catalogVersion ?? null, to: baseVersion(newCatalog) },
    candidates,
    overrideFiles: loaded.files,
    overrides: diffOverrides(manifest, newCatalog),
    recommendations,
    rejections,
    files: { written: [], kept: [], conflicts: [] },
    notes,
  };
  const withOwn = (names) => [...new Set([...names, '.ai/manifest.json', '.ai/refresh-report.md'])].sort(byText);

  const result = writeAiDir(root, {
    now,
    local,
    workspace,
    repos: workspace?.role === 'hub' ? readJson(path.join(aiDir, 'repos.json')) : null,
    appendPointers: false,
    toolVersion: toolTo,
    skillDir,
    catalogDir,
    extraGenerated: (files) => {
      // Scan after the managed and user-owned files are settled, before the report is rendered.
      const byFile = new Map();
      for (const f of scanAiDir(root)) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f.line]);
      for (const [file, lines] of byFile) {
        notes.push(`suspicious instruction-like text in ${file} (lines ${[...new Set(lines)].join(', ')}): review before trusting it`);
      }
      report.files = { written: withOwn(files.written), kept: files.kept, conflicts: files.conflicts };
      const meta = { date: now.toISOString().slice(0, 10), commit: files.commit, catalogVersion: newCatalog.catalogVersion };
      return { 'refresh-report.md': renderReport(report, meta) };
    },
  });
  report.files = { written: result.written, kept: result.kept, conflicts: result.conflicts };
  return report;
}
