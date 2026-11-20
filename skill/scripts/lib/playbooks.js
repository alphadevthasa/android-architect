// Migration playbooks: loading, validation and applying one to a StackProfile.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontMatter, reopenHolds } from './adr.js';
import { presentEntries } from './candidates.js';
import { playbooksDir } from './catalog.js';

export { playbooksDir };

const KEYS = ['id', 'dimension', 'from', 'to', 'title', 'irreversible', 'kmpOnly', 'worthIf', 'asOf', 'verified'];
const REQUIRED = ['id', 'dimension', 'from', 'to', 'title', 'irreversible', 'kmpOnly', 'asOf', 'verified'];
const BOOLEANS = ['irreversible', 'kmpOnly', 'verified'];
export const SECTIONS = [
  'When it is worth it', 'When not to', 'Preconditions', 'Steps', 'Pitfalls', 'Tests', 'Security checklist', 'Rollback',
];
const STEPS_MENTIONS = [
  ['seam', 'the seam'],
  ['side by side', 'running both implementations side by side'],
  ['cutover', 'per-unit cutover'],
  ['delet', 'deleting the old implementation'],
];
const COND_RE = /^(present|absent):\S+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_UNITS = 200;

/** Splits the body into `## ` sections (fenced code is not scanned for headings). Order and names are checked by the caller. */
function splitSections(body, file) {
  const found = [];
  let fence = null;
  for (const line of body.split('\n')) {
    const f = /^ {0,3}(```+|~~~+)/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    if (fence === null && !f && line.startsWith('## ')) {
      found.push({ name: line.slice(3).trim(), lines: [] });
    } else if (found.length > 0) {
      found[found.length - 1].lines.push(line);
    }
  }
  const names = found.map((s) => s.name);
  for (const [i, n] of names.entries()) {
    if (!SECTIONS.includes(n)) throw new Error(`${file}: unknown section "${n.slice(0, 60)}"`);
    if (names.indexOf(n) !== i) throw new Error(`${file}: duplicate section "${n}"`);
  }
  for (const n of SECTIONS) {
    if (!names.includes(n)) throw new Error(`${file}: missing section "${n}"`);
  }
  if (names.join('\n') !== SECTIONS.join('\n')) {
    throw new Error(`${file}: sections must appear in this order: ${SECTIONS.join(', ')}`);
  }
  const sections = {};
  for (const s of found) {
    sections[s.name] = s.lines.join('\n').trim();
    if (sections[s.name] === '') throw new Error(`${file}: section "${s.name}" is empty`);
  }
  return sections;
}

/** Parse one playbook file's text. Throws a file-prefixed Error when it does not follow the format. */
export function parsePlaybook(text, file) {
  const { data, quoted, body } = parseFrontMatter(text, file, { keys: KEYS, listKeys: ['worthIf'], required: REQUIRED });
  for (const k of BOOLEANS) {
    if (quoted.has(k) || (data[k] !== 'true' && data[k] !== 'false')) {
      throw new Error(`${file}: ${k} must be the bare word true or false, got "${data[k].slice(0, 40)}"`);
    }
    data[k] = data[k] === 'true';
  }
  if (!DATE_RE.test(data.asOf)) throw new Error(`${file}: asOf must be a YYYY-MM-DD date, got "${data.asOf.slice(0, 40)}"`);
  if (data.from === data.to) throw new Error(`${file}: from and to must differ`);
  if (data.id !== `${data.from}--to--${data.to}`) throw new Error(`${file}: id must be "${data.from}--to--${data.to}"`);
  for (const c of data.worthIf) {
    if (!COND_RE.test(c)) throw new Error(`${file}: worthIf item "${c.slice(0, 60)}" must be present:<id> or absent:<id>`);
  }
  const sections = splitSections(body, file);
  const securityChecklist = sections['Security checklist']
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((l) => l !== '');
  if (securityChecklist.length < 2) throw new Error(`${file}: Security checklist needs at least 2 list items`);
  return { ...data, sections, securityChecklist, file };
}

/** Load one playbook by explicit path (used for the documented example). */
export function loadPlaybookFile(filePath) {
  return parsePlaybook(fs.readFileSync(filePath, 'utf8'), path.basename(filePath));
}

/** Load every `<from>--to--<to>.md` in dir; `_*` files and README.md are skipped. Sorted by file name. */
export function loadPlaybooks(dir) {
  const names = fs.readdirSync(dir)
    .filter((n) => n.endsWith('.md') && n !== 'README.md' && !n.startsWith('_'))
    .sort();
  return names.map((n) => {
    const pb = loadPlaybookFile(path.join(dir, n));
    if (n !== `${pb.id}.md`) throw new Error(`${n}: file name must be "${pb.id}.md"`);
    return pb;
  });
}

function reachableFrom(catalog, dim, from) {
  const seen = new Set();
  const stack = [from];
  while (stack.length > 0) {
    for (const s of catalog.entry(dim, stack.pop())?.successors ?? []) {
      if (!seen.has(s)) {
        seen.add(s);
        stack.push(s);
      }
    }
  }
  return seen;
}

/** Catalog-level problems of the playbooks (each prefixed with the file); empty when all are valid. */
export function validatePlaybooks(playbooks, catalog) {
  const errs = [];
  const ids = new Set();
  const dims = new Set(catalog.dimensions.map((d) => d.id));
  for (const p of playbooks) {
    const bad = (m) => errs.push(`${p.file}: ${m}`);
    if (ids.has(p.id)) bad(`duplicate playbook id "${p.id}"`);
    ids.add(p.id);
    if (!dims.has(p.dimension)) {
      bad(`dimension "${p.dimension}" is not a catalog dimension`);
      continue;
    }
    for (const side of ['from', 'to']) {
      if (catalog.entry(p.dimension, p[side]) === undefined) bad(`${side} "${p[side]}" is not an entry of "${p.dimension}"`);
    }
    if (p.from === p.to) bad('from and to must differ');
    else if (catalog.entry(p.dimension, p.from) !== undefined && catalog.entry(p.dimension, p.to) !== undefined
      && !reachableFrom(catalog, p.dimension, p.from).has(p.to)) {
      bad(`"${p.to}" is not reachable from "${p.from}" by catalog successors`);
    }
    for (const sec of SECTIONS) if (typeof p.sections?.[sec] !== 'string') bad(`missing section "${sec}"`);
    if ((p.securityChecklist?.length ?? 0) < 2) bad('Security checklist needs at least 2 list items');
    const steps = (p.sections?.Steps ?? '').toLowerCase();
    for (const [needle, what] of STEPS_MENTIONS) if (!steps.includes(needle)) bad(`Steps must mention ${what}`);
    for (const c of p.worthIf ?? []) if (!COND_RE.test(c)) bad(`worthIf item "${String(c).slice(0, 60)}" is invalid`);
  }
  return errs;
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Apply a playbook to a profile. Never invents units: when `from` is not detected the result is not applicable
 * and has no cutover units.
 */
export function applyPlaybook(playbook, profile, catalog) {
  const tags = [];
  if (playbook.irreversible) tags.push('irreversible');
  if (playbook.securityChecklist.length > 0) tags.push('decision');
  const base = {
    cutoverUnits: [], moreUnits: 0, gated: tags.length > 0, tags, securityChecklist: [...playbook.securityChecklist],
  };
  const fromEntry = presentEntries(profile, playbook.dimension).find((e) => e.id === playbook.from);
  if (fromEntry === undefined) {
    return { applicable: false, reason: `${playbook.from} not detected in this project`, worth: { ok: false, notes: [] }, ...base };
  }

  const notes = [];
  for (const cond of playbook.worthIf) {
    if (reopenHolds(cond, profile)) continue;
    const intro = oneLine(playbook.sections['When it is worth it'].split('\n')[0]).slice(0, 300);
    notes.push(`worth-it condition not met: ${cond}${intro === '' ? '' : `. ${intro}`}`);
  }

  const modules = [...(profile.modules ?? [])].sort((a, b) => b.dir.length - a.dir.length);
  const owner = (file) => modules.find((m) => m.dir === '' || file === m.dir || file.startsWith(m.dir + '/'))?.path ?? null;
  const seen = new Set();
  const units = [];
  for (const ev of fromEntry.evidence ?? []) {
    if (typeof ev?.file !== 'string') continue;
    const line = Number.isInteger(ev.line) ? ev.line : null;
    const key = `${ev.file}\n${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    units.push({ file: ev.file, line, module: owner(ev.file) });
  }
  units.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0)));
  return {
    applicable: true,
    worth: { ok: notes.length === 0, notes },
    ...base,
    cutoverUnits: units.slice(0, MAX_UNITS),
    moreUnits: Math.max(0, units.length - MAX_UNITS),
  };
}
