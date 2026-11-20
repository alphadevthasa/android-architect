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

/** Removes Unicode bidi controls and line/paragraph separators (they can visually reorder or forge lines). */
export const stripUnsafe = (s) => String(s).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, ' ');

/** One line of Markdown-safe text: whitespace collapsed, pipes escaped, no leading heading, quote or list marker. */
export const mdText = (s) => {
  const t = stripUnsafe(s)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[\s\u2028\u2029]+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/`/g, "'");
  return /^[#>-]/.test(t) ? '\\' + t : t;
};

/** Markdown for a buildFeatureMap result: notes, one table per bucket, then the reasons per feature. */
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

export const COMPONENTS_BEGIN = '<!-- android-architect:components:begin -->';
export const COMPONENTS_END = '<!-- android-architect:components:end -->';
const COMPONENTS_NOTE = '<!-- generated by android-architect: refresh rewrites everything between the begin and end markers. Write your own notes outside them. -->';
const MAX_GROUPS = 20;
const MAX_FILES = 10;

const place = (f) => `${mdText(f.file)}:${f.line}`;
const more = (n, what) => `... and ${n} more ${what}`;

function groupLines(groups, describe) {
  const out = [];
  for (const g of groups.slice(0, MAX_GROUPS)) {
    const shown = g.files.slice(0, MAX_FILES).map(place);
    if (g.files.length > MAX_FILES) shown.push(more(g.files.length - MAX_FILES, 'files'));
    out.push(`- ${describe(g)}: ${shown.join(', ')}`);
  }
  if (groups.length > MAX_GROUPS) out.push(`- ${more(groups.length - MAX_GROUPS, 'groups')}`);
  return out;
}

/**
 * The tool-owned block of knowledge/components.md, markers included, without a trailing newline.
 * `reuse` is a detectReuse result, { error } or null. Every name comes from the project, so it passes through mdText.
 */
export function renderComponentsBlock(reuse) {
  const out = [COMPONENTS_BEGIN, COMPONENTS_NOTE, '', '## Detected reuse candidates', ''];
  if (!reuse) {
    out.push('Reuse detection was not computed for this run.');
  } else if (reuse.error !== undefined) {
    out.push(`Reuse detection was not computed: ${mdText(reuse.error)}`);
  } else {
    const n = reuse.duplicates.length;
    out.push(`Duplication: ${reuse.duplicationScore} (${n} duplicate ${n === 1 ? 'group' : 'groups'}).`, '');
    if (reuse.tooLarge > 0) out.push(`${reuse.tooLarge} ${reuse.tooLarge === 1 ? 'file' : 'files'} too large to scan: left out of every check below.`, '');
    out.push('### Shared modules', '');
    if (reuse.sharedModules.length === 0) out.push('None detected: new shared components need a home (see the reuse reference).');
    for (const m of reuse.sharedModules) out.push(`- ${mdText(m)}`);
    out.push('', '### Duplicate groups', '');
    if (n === 0) out.push('None detected.');
    out.push(...groupLines(reuse.duplicates, (g) => `${g.kind} ${mdText(g.signature)}`));
    out.push('', '### Competing base classes', '');
    if (reuse.baseClasses.length === 0) out.push('None detected.');
    for (const g of reuse.baseClasses) {
      const shown = g.classes.slice(0, MAX_FILES).map((c) => `${mdText(c.name)} (${mdText(c.file)}:${c.line})`);
      if (g.classes.length > MAX_FILES) shown.push(more(g.classes.length - MAX_FILES, 'classes'));
      out.push(`- ${g.role}: ${shown.join(', ')}`);
    }
    out.push('', '### Repeated boilerplate', '');
    if (reuse.boilerplate.length === 0) out.push('None detected.');
    out.push(...groupLines(reuse.boilerplate, (g) => `${g.kind} ${mdText(g.signature)}`));
    const t = reuse.tokens;
    out.push('', '### Design tokens', '');
    out.push(`- colors.xml entries: ${t.colorsXml}, dimens.xml entries: ${t.dimensXml}`);
    out.push(`- hardcoded colors: ${t.hardcodedColors}, hardcoded dp values: ${t.hardcodedDp} (outside token files)`);
  }
  out.push(COMPONENTS_END);
  return out.join('\n');
}

/**
 * Marker lines outside fenced code blocks: { begins, ends, open } with line indexes; `open` is true when a fence is still
 * open at the end. A marker counts only when the whole line is the marker at column 0 (one trailing \r allowed), so
 * indented code, fenced examples and prose that quotes a marker are never mistaken for it.
 */
function findMarkers(lines) {
  const begins = [];
  const ends = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    if (i === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    let k = 0;
    while (k < 3 && line[k] === ' ') k++;
    const c = line[k];
    if (c === '`' || c === '~') {
      let n = 0;
      while (line[k + n] === c) n++;
      if (n >= 3) {
        if (fence === null) {
          // A backtick fence's info string cannot contain a backtick: ```x``` is inline code.
          if (c === '`' && line.slice(k + n).includes('`')) {
            // not a fence
          } else {
            fence = { c, n };
            continue;
          }
        } else if (fence.c === c && n >= fence.n && line.slice(k + n).trim() === '') {
          fence = null;
          continue;
        }
      }
    }
    if (fence !== null) continue;
    if (line === COMPONENTS_BEGIN) begins.push(i);
    else if (line === COMPONENTS_END) ends.push(i);
  }
  return { begins, ends, fence };
}

/**
 * Put `block` into the text of components.md and return { text, note }. Only the block changes; every other byte is kept.
 *   - exactly one begin and one end marker line, in order: that span is replaced;
 *   - no markers: the block is appended;
 *   - anything else (lone, duplicated or reordered markers): the last begin/end pair is replaced only when it ends the
 *     file (it is the block a previous run appended), else a fresh block is appended. Nothing is ever deleted, and `note`
 *     says the markers are malformed. An unclosed code fence at the end of the file is closed before the appended block.
 * The block is written with the file's dominant line ending.
 */
export function applyComponentsBlock(existing, block) {
  const crlf = (existing.match(/\r\n/g) ?? []).length > (existing.match(/(^|[^\r])\n/g) ?? []).length;
  const eol = crlf ? '\r\n' : '\n';
  const blockLines = block.split('\n');
  const lines = existing.split('\n');
  const { begins, ends, fence } = findMarkers(lines);
  const splice = (b, e) => {
    const mid = blockLines.map((l, k) => (crlf && (k < blockLines.length - 1 || e < lines.length - 1) ? l + '\r' : l));
    if (b === 0 && existing.charCodeAt(0) === 0xfeff) mid[0] = '\uFEFF' + mid[0]; // keep the BOM
    return [...lines.slice(0, b), ...mid, ...lines.slice(e + 1)].join('\n');
  };
  const append = () => {
    let text = existing;
    if (fence !== null) text += (text.endsWith('\n') ? '' : eol) + fence.c.repeat(fence.n) + eol;
    const sep = text === '' ? '' : text.endsWith('\n') ? eol : eol + eol;
    return `${text}${sep}${blockLines.join(eol)}${eol}`;
  };
  if (begins.length === 1 && ends.length === 1 && begins[0] < ends[0]) return { text: splice(begins[0], ends[0]), note: null };
  if (begins.length === 0 && ends.length === 0) return { text: append(), note: null };
  const note = 'knowledge/components.md has malformed android-architect markers (expected one begin line and one end line, outside code fences); your text was left untouched and the generated block is kept at the end of the file';
  const b = begins[begins.length - 1];
  const e = ends[ends.length - 1];
  const tail = b !== undefined && e !== undefined && b < e && lines.slice(e + 1).every((l) => l.trim() === '');
  const clean = tail && !begins.some((x) => x > b && x < e) && !ends.some((x) => x > b && x < e);
  return { text: clean ? splice(b, e) : append(), note };
}

/** components.md text: `existingText` with the generated block replaced (or appended). Idempotent. */
export function renderComponents(reuse, existingText) {
  return applyComponentsBlock(existingText, renderComponentsBlock(reuse)).text;
}
