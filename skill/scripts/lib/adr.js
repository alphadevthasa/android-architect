// Parses ADR files (restricted front matter) and derives remembered rejections.
import fs from 'node:fs';
import path from 'node:path';
import { presentEntries } from './candidates.js';

const KEYS = ['id', 'title', 'status', 'date', 'dimension', 'target', 'reopenIf', 'reason', 'fitness'];
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

/**
 * Splits `---` front matter from the body and parses it with the strict scalar grammar above.
 * `keys` is the allowed key set, `listKeys` the keys that hold "- item" lists, `required` keys that must be non-empty.
 * Returns { data, quoted, bodyStart, body }: `data` has every key (lists default to [], scalars to ''), `quoted` is the
 * set of scalar keys written with double quotes, `seen` the set of keys present, `bodyStart` the 1-based line number of
 * the first body line.
 */
export function parseFrontMatter(text, file, { keys, listKeys = [], required = [] }) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') throw new Error(`${file}: missing front matter`);
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new Error(`${file}: unterminated front matter`);

  const out = Object.fromEntries(keys.map((k) => [k, listKeys.includes(k) ? [] : '']));
  const quoted = new Set();
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
    if (!keys.includes(key)) throw new Error(`${file}: line ${lineNo}: unknown key "${key}"`);
    if (seen.has(key)) throw new Error(`${file}: line ${lineNo}: duplicate key "${key}"`);
    seen.add(key);
    listKey = null;
    if (listKeys.includes(key)) {
      const rest = (m[2] ?? '').trim();
      if (rest !== '') {
        scalar(rest, file, lineNo);
        throw new Error(`${file}: line ${lineNo}: ${key} must be a list of "- item" lines`);
      }
      listKey = key;
    } else {
      out[key] = scalar(m[2] ?? '', file, lineNo);
      if ((m[2] ?? '').trim()[0] === '"') quoted.add(key);
    }
  }
  for (const k of required) {
    if (out[k] === '' || (Array.isArray(out[k]) && out[k].length === 0)) throw new Error(`${file}: missing required key "${k}"`);
  }
  return { data: out, quoted, seen, bodyStart: end + 2, body: lines.slice(end + 1).join('\n') };
}

export function parseAdr(text, file) {
  const { data: out, seen } = parseFrontMatter(text, file, { keys: KEYS, listKeys: ['reopenIf', 'fitness'], required: REQUIRED });
  // `fitness` (architecture fitness rules, see references/fitness.md) is optional: only present when written.
  if (!seen.has('fitness')) delete out.fitness;
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
