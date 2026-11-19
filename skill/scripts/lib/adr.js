// Parses ADR files (restricted front matter) and derives remembered rejections.
import fs from 'node:fs';
import path from 'node:path';
import { presentEntries } from './candidates.js';

const KEYS = ['id', 'title', 'status', 'date', 'dimension', 'target', 'reopenIf', 'reason'];
const STATUSES = ['proposed', 'accepted', 'superseded', 'rejected'];
const REQUIRED = ['id', 'title', 'status'];

function scalar(raw, file, lineNo) {
  const v = raw.trim();
  const bad = (what) => new Error(`${file}: line ${lineNo}: ${what} is not supported`);
  if (v === '') return '';
  if (v[0] === '"') {
    if (v.length < 2 || v[v.length - 1] !== '"') throw new Error(`${file}: line ${lineNo}: unterminated quoted value`);
    return v.slice(1, -1).trim();
  }
  if (v[0] === '&' || v[0] === '*') throw bad('YAML anchor or alias');
  if (v[0] === '!') throw bad('YAML tag');
  if (v[0] === '|' || v[0] === '>') throw bad('block scalar');
  if (v[0] === '[' || v[0] === '{') throw bad('flow collection');
  if (v[0] === "'") throw bad('single-quoted value');
  if (v[0] === '#') throw new Error(`${file}: line ${lineNo}: a value starting with "#" is not supported (quote it if it is meant literally)`);
  if (/\s#/.test(v)) throw new Error(`${file}: line ${lineNo}: inline comments are not supported (quote the value if it contains " #")`);
  return v;
}

export function parseAdr(text, file) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') throw new Error(`${file}: missing front matter`);
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new Error(`${file}: unterminated front matter`);

  const out = { id: '', title: '', status: '', date: '', dimension: '', target: '', reopenIf: [], reason: '' };
  const seen = new Set();
  let listKey = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.trim() === '') continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item) {
      if (listKey === null) throw new Error(`${file}: line ${lineNo}: list item without a list key`);
      out[listKey].push(scalar(item[1], file, lineNo));
      continue;
    }
    if (/^\s/.test(line)) throw new Error(`${file}: line ${lineNo}: multi-line values are not supported`);
    const m = /^([A-Za-z][A-Za-z0-9]*):(?:\s+(.*)|\s*)$/.exec(line);
    if (!m) throw new Error(`${file}: line ${lineNo}: expected "key: value"`);
    const key = m[1];
    if (!KEYS.includes(key)) throw new Error(`${file}: line ${lineNo}: unknown key "${key}"`);
    if (seen.has(key)) throw new Error(`${file}: line ${lineNo}: duplicate key "${key}"`);
    seen.add(key);
    listKey = null;
    if (key === 'reopenIf') {
      const rest = (m[2] ?? '').trim();
      if (rest !== '') {
        scalar(rest, file, lineNo);
        throw new Error(`${file}: line ${lineNo}: reopenIf must be a list of "- item" lines`);
      }
      listKey = 'reopenIf';
    } else {
      out[key] = scalar(m[2] ?? '', file, lineNo);
    }
  }
  for (const k of REQUIRED) {
    if (out[k] === '') throw new Error(`${file}: missing required key "${k}"`);
  }
  if (!STATUSES.includes(out.status)) {
    throw new Error(`${file}: status must be one of ${STATUSES.join(', ')}, got "${out.status}"`);
  }
  if (out.status === 'rejected' && (out.dimension.trim() === '' || out.target.trim() === '')) {
    throw new Error(`${file}: rejected ADR needs dimension and target`);
  }
  return { ...out, file };
}

const ADR_FILE = /^\d{4}-.*\.md$/;

/** Parse the ADR files in dir (NNNN-*.md, except the template); other files such as a README are ignored. */
export function loadAdrs(dir) {
  const names = fs.readdirSync(dir)
    .filter((n) => ADR_FILE.test(n) && n !== '0000-template.md')
    .sort();
  return names.map((n) => parseAdr(fs.readFileSync(path.join(dir, n), 'utf8'), n));
}

/** Warnings (not failures) for rejected ADRs whose dimension or target is not a catalog id: they block nothing. */
export function adrWarnings(adrs, catalog) {
  const dims = new Set(catalog.dimensions.map((d) => d.id));
  const out = [];
  for (const adr of adrs) {
    if (adr.status !== 'rejected') continue;
    if (!dims.has(adr.dimension)) {
      out.push(`${adr.file}: dimension "${adr.dimension}" is not a catalog dimension id; this rejection blocks nothing`);
    } else if (catalog.entry(adr.dimension, adr.target) === undefined) {
      out.push(`${adr.file}: target "${adr.target}" is not an entry of "${adr.dimension}" in the catalog; this rejection blocks nothing`);
    }
  }
  return out;
}

export function reopenHolds(cond, profile) {
  const m = /^(present|absent):(\S+)$/.exec(typeof cond === 'string' ? cond.trim() : '');
  if (!m) return false;
  const present = Object.keys(profile?.dimensions ?? {})
    .some((dim) => presentEntries(profile, dim).some((e) => e.id === m[2]));
  return m[1] === 'present' ? present : !present;
}

export function activeRejections(adrs, profile) {
  const blocked = [];
  const reopened = [];
  for (const adr of adrs) {
    if (adr.status !== 'rejected') continue;
    const base = { dimension: adr.dimension, target: adr.target, adr };
    const condition = adr.reopenIf.find((c) => reopenHolds(c, profile));
    if (condition !== undefined) reopened.push({ ...base, condition });
    else blocked.push(base);
  }
  return { blocked, reopened };
}
