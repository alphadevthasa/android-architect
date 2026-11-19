import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProfileMarkdown } from './report.js';

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
      out.push(`- ${name} (${e.id}): ${share}${where}`);
    }
    out.push('');
  }
  const { sdk } = profile;
  out.push('## Overview', '');
  out.push(`- Modules: ${profile.modules.length}`);
  out.push(`- SDK: min ${sdk.minSdk ?? '?'}, target ${sdk.targetSdk ?? '?'}, compile ${sdk.compileSdk ?? '?'}`);
  out.push('', '## Compliance gaps', '');
  const gaps = profile.compliance.filter((c) => c.status !== 'pass' && c.status !== 'ok');
  if (gaps.length === 0) out.push('- none');
  for (const c of gaps) out.push(`- ${catalog.entry('compliance', c.id)?.name ?? c.id}: ${c.status} (${c.detail})`);
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

/** Render the generated knowledge files, keyed by path relative to `.ai/`. */
export function renderKnowledge(profile, modules, catalog, meta) {
  const header = generatedHeader(meta);
  const withHeader = (body) => `${header}\n\n${body}`;
  return {
    'knowledge/stack-profile.md': withHeader(renderProfileMarkdown(profile, catalog)),
    'knowledge/architecture-current.md': withHeader(renderArchitecture(profile, catalog)),
    'knowledge/module-map.md': withHeader(renderModuleMap(modules)),
    'knowledge/dependencies.md': withHeader(renderDependencies(modules)),
    'knowledge/feature-map.md': withHeader(
      '# Feature map\n\nTODO: feature scores arrive with the "prioritize" command in a later version.\n',
    ),
  };
}
