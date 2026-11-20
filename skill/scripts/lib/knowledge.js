import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProfileMarkdown } from './report.js';
import { oneLine } from './overrides.js';
import { findingCountLines, severityCount } from './security.js';

const DEFAULT_TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'ai');
const PLACEHOLDERS = ['toolVersion', 'catalogVersion', 'date', 'commit', 'mode', 'workspace'];

/** The exact header line that starts every generated Markdown file. */
export function generatedHeader({ date, commit, catalogVersion }) {
  return `<!-- generated: ${date} @ ${commit || 'no-git'}, catalog ${catalogVersion}. Do not edit: refresh overwrites this file. -->`;
}

/** Read a template file relative to the templates directory. */
export function readTemplate(rel, templatesDir = DEFAULT_TEMPLATES) {
  return fs.readFileSync(path.join(templatesDir, rel), 'utf8');
}

/** Fill README.md.tpl. Missing values and unknown placeholders throw. */
export function renderReadme(values, templatesDir = DEFAULT_TEMPLATES) {
  const v = { ...values, commit: values.commit || 'no-git', workspace: values.workspace ?? 'none' };
  return readTemplate('README.md.tpl', templatesDir).replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_, name) => {
    if (!PLACEHOLDERS.includes(name)) throw new Error(`Unknown template placeholder: ${name}`);
    const val = v[name];
    if (val === undefined || val === null || val === '') throw new Error(`Missing value for template placeholder: ${name}`);
    return String(val);
  });
}

const pct = (share, units) => (Math.round(share * 100) === 0 && units > 0 ? '<1%' : `${Math.round(share * 100)}%`);
const cell = (s) => String(s).replace(/\|/g, '\\|');
const mermaidId = (p) => 'm_' + (p.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root');

function renderArchitecture(profile, catalog) {
  const out = ['# Current architecture', ''];
  for (const dim of catalog.dimensions) {
    const entries = profile.dimensions[dim.id]?.entries ?? [];
    if (entries.length === 0) continue;
    out.push(`## ${dim.name}`, '');
    for (const e of entries) {
      const name = catalog.entry(dim.id, e.id)?.name ?? e.id;
      const share = e.share === null || e.share === undefined ? 'present' : pct(e.share, e.units);
      const ev = e.evidence?.[0];
      const where = ev ? ` (evidence: ${ev.line === null || ev.line === undefined ? ev.file : `${ev.file}:${ev.line}`})` : '';
      out.push(`- ${oneLine(name)} (${e.id}): ${share}${where}`);
    }
    out.push('');
  }
  const ov = catalog.overridden;
  if (ov && (ov.added.length || ov.statusPinned.length)) {
    out.push('## Catalog overrides', '', 'Project-specific catalog changes from `.ai/catalog-overrides/` (not part of the shared catalog).', '');
    for (const id of ov.added) out.push(`- Added entry: ${id} (${oneLine(catalog.entry(id.slice(0, id.indexOf('.')), id.slice(id.indexOf('.') + 1))?.name ?? id)})`);
    for (const [id, p] of Object.entries(ov.pins)) out.push(`- Status pin: ${id} is ${p.status} (reason: ${oneLine(p.reason)})`);
    out.push('');
  }
  const { sdk } = profile;
  out.push('## Overview', '');
  out.push(`- Modules: ${profile.modules.length}`);
  out.push(`- SDK: min ${sdk.minSdk ?? '?'}, target ${sdk.targetSdk ?? '?'}, compile ${sdk.compileSdk ?? '?'}`);
  const line = (c) => `- ${catalog.entry('compliance', c.id)?.name ?? c.id}: ${c.status} (${c.detail})`;
  const gaps = profile.compliance.filter((c) => c.status === 'gap');
  const unknown = profile.compliance.filter((c) => c.status === 'unknown');
  out.push('', '## Compliance gaps', '');
  if (gaps.length === 0) out.push('- none');
  for (const c of gaps) out.push(line(c));
  if (unknown.length) {
    out.push('', '## Compliance not verifiable statically', '');
    for (const c of unknown) out.push(line(c));
  }
  const findings = profile.security?.findings ?? [];
  const count = (sev) => severityCount(profile.security, sev);
  out.push('', '## Security signals', '');
  out.push(`- high: ${count('high')}, medium: ${count('medium')}, low: ${count('low')}`);
  out.push(...findingCountLines(profile.security));
  for (const f of findings.slice(0, 10)) out.push(`- [${f.severity}] ${f.id}: ${f.file}:${f.line} (${f.detail})`);
  const vulnerable = profile.security?.vulnerable ?? [];
  if (vulnerable.length) {
    out.push('', '## Vulnerable dependencies', '');
    for (const v of vulnerable.slice(0, 10)) out.push(`- [${v.severity}] ${v.id}: ${v.coord}:${v.version} at ${v.file}:${v.line}`);
  }
  return out.join('\n') + '\n';
}

function renderModuleMap(modules) {
  const out = ['# Module map', '', '| module | dir | depends on |', '| --- | --- | --- |'];
  for (const m of modules) {
    out.push(`| ${cell(m.path)} | ${cell(m.dir || '.')} | ${cell(m.projectDeps.join(', ') || '-')} |`);
  }
  out.push('', '```mermaid', 'graph TD');
  for (const m of modules) out.push(`  ${mermaidId(m.path)}["${m.path}"]`);
  for (const m of modules) for (const to of m.projectDeps) out.push(`  ${mermaidId(m.path)} --> ${mermaidId(to)}`);
  out.push('```');
  return out.join('\n') + '\n';
}

const coordinate = (d) => (d.group && d.name ? `${d.group}:${d.name}` : d.name || d.alias || '(unknown)');
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function renderDependencies(modules) {
  const out = ['# Dependencies', ''];
  for (const m of modules) {
    const deps = m.build?.dependencies ?? [];
    out.push(`## ${m.path}`, '');
    const external = deps
      .filter((d) => !d.project)
      .map((d) => [d.configuration, coordinate(d), d.unresolved ? 'unresolved' : d.version || '-'])
      .sort((a, b) => byText(a.join('\u0000'), b.join('\u0000')));
    if (external.length) {
      out.push('| configuration | coordinate | version |', '| --- | --- | --- |');
      for (const r of external) out.push(`| ${r.map(cell).join(' | ')} |`);
    } else {
      out.push('No external dependencies.');
    }
    const projects = deps.filter((d) => d.project).map((d) => `${d.configuration}: project(${d.project})`).sort(byText);
    if (projects.length) {
      out.push('', 'Project dependencies:', '');
      for (const p of projects) out.push(`- ${p}`);
    }
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

const BUCKET_TITLES = {
  first: 'First: pilot candidates',
  next: 'Next: after the pilot',
  last: 'Last: needs preparation or has high risk',
};

/** Markdown for a buildFeatureMap result: notes, one table per bucket, then the reasons per feature. */
/** One line of Markdown-safe text: whitespace collapsed, pipes escaped, no leading heading, quote or list marker. */
const mdText = (s) => {
  const t = String(s).replace(/[\s\u2028\u2029]+/g, ' ').trim().replace(/\|/g, '\\|');
  return /^[#>-]/.test(t) ? '\\' + t : t;
};

export function renderFeatureMap(map) {
  const out = ['# Feature map', ''];
  if (!map) return out.concat('feature map not computed: no data for this run', '').join('\n');
  if (map.error !== undefined) return out.concat(`feature map not computed: ${mdText(map.error)}`, '').join('\n');
  out.push('Candidates ranked for migration by a tunable score (weights and thresholds: `catalog/scoring.json`).', '');
  if (map.fallback === 'packages') out.push('No feature modules or `feature/<name>` packages found: units are top-level packages.', '');
  else if (map.fallback === 'app') out.push('No feature structure found: the whole project is one unit.', '');
  if (!map.churnAvailable) out.push('Git history is not available: churn is not part of the score.', '');
  for (const bucket of ['first', 'next', 'last']) {
    const list = map.features.filter((f) => f.bucket === bucket);
    out.push(`## ${BUCKET_TITLES[bucket]}`, '');
    if (list.length === 0) {
      out.push('None.', '');
      continue;
    }
    out.push('| feature | kind | score | risk | loc | tests | fan-in | fan-out | churn | proximity |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const f of list) {
      const row = [f.name, f.kind, f.score, f.risk, f.loc, f.testFiles, f.fanIn, f.fanOut, f.churn ?? 'n/a', f.proximity];
      out.push(`| ${row.map(mdText).join(' | ')} |`);
    }
    out.push('');
    for (const f of list) out.push(`- ${mdText(f.name)}: ${f.reasons.map(mdText).join('; ')}`);
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

/** Render the generated knowledge files, keyed by path relative to `.ai/`. */
export function renderKnowledge(profile, modules, catalog, meta, featureMap = null) {
  const header = generatedHeader(meta);
  const withHeader = (body) => `${header}\n\n${body}`;
  return {
    'knowledge/stack-profile.md': withHeader(renderProfileMarkdown(profile, catalog)),
    'knowledge/architecture-current.md': withHeader(renderArchitecture(profile, catalog)),
    'knowledge/module-map.md': withHeader(renderModuleMap(modules)),
    'knowledge/dependencies.md': withHeader(renderDependencies(modules)),
    'knowledge/feature-map.md': withHeader(renderFeatureMap(featureMap)),
  };
}
