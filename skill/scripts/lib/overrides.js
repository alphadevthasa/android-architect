// Project catalog overrides: <root>/.ai/catalog-overrides/*.json add entries to existing dimensions and pin statuses.
// Override files live in the repo, so they are untrusted input: everything is validated before use, regexes and globs
// carry no regexes (literal `contains` only) and globs use a tiny grammar, and nothing is evaluated.
import fs from 'node:fs';
import path from 'node:path';
import { CatalogError, loadCatalog, validateEntry, SUPPORTED_SCHEMA_VERSION } from './catalog.js';
import { globToRegExp } from './glob.js';
import { readManifest } from './manifest.js';

export const OVERRIDES_DIR = 'catalog-overrides';
export const MAX_FILES = 20;
export const MAX_ENTRIES_PER_FILE = 50;
const MAX_PATTERN = 200;
const MAX_STRING = 500;
const MAX_FILE_BYTES = 256 * 1024;
const STATUSES = ['current', 'legacy', 'deprecated'];

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Override globs are deliberately tiny, because a glob becomes a RegExp run over every project path: literal segments,
 * an optional single leading "**\/", at most one "*" per segment, at most 2 "*" in all (a "**" counts as one), no "?",
 * no braces or classes, at most 200 characters.
 */
function globProblem(glob) {
  if (typeof glob !== 'string' || glob.length === 0) return 'must be a non-empty string';
  if (glob.length > MAX_PATTERN) return `is longer than ${MAX_PATTERN} characters`;
  const rest = glob.startsWith('**/') ? glob.slice(3) : glob;
  let stars = rest === glob ? 0 : 1;
  if (rest.length === 0) return 'needs a file or directory name after "**/"';
  for (const seg of rest.split('/')) {
    if (seg.length === 0) return 'has an empty path segment';
    if (/[?{}[\]]/.test(seg)) return 'may not use ?, braces or classes';
    if (seg.includes('**')) return 'may use "**" only as a single leading "**/"';
    const n = seg.split('*').length - 1;
    if (n > 1) return 'may use at most one "*" per path segment';
    stars += n;
  }
  if (stars > 2) return 'may use at most 2 "*" in total';
  try {
    globToRegExp(glob);
  } catch {
    return 'is not a valid glob';
  }
  return null;
}

/**
 * Linear matcher for the tiny glob grammar (no RegExp): segments split on `sep` (default "/"), at most one "*" per
 * segment ("*" matches any run of characters inside one segment), an optional leading "**" segment (zero or more
 * segments before the rest) or an optional trailing "**" segment (one or more segments after the rest). A pattern
 * outside the grammar throws instead of being guessed at. For the override grammar it agrees with globToRegExp.
 */
export function matchGlob(pattern, text, { sep = '/' } = {}) {
  const ps = String(pattern).split(sep);
  const ts = String(text).split(sep);
  const lead = ps.length > 1 && ps[0] === '**';
  const trail = !lead && ps.length > 1 && ps[ps.length - 1] === '**';
  const core = ps.slice(lead ? 1 : 0, trail ? ps.length - 1 : ps.length);
  for (const seg of core) {
    if (seg.includes('**') || seg.indexOf('*') !== seg.lastIndexOf('*')) throw new Error('glob outside the supported grammar');
  }
  let offset = 0;
  if (lead) {
    if (ts.length < core.length) return false;
    offset = ts.length - core.length;
  } else if (trail) {
    if (ts.length <= core.length) return false;
  } else if (ts.length !== core.length) return false;
  return core.every((p, i) => segmentMatches(p, ts[offset + i]));
}

function segmentMatches(p, s) {
  const star = p.indexOf('*');
  if (star === -1) return p === s;
  const pre = p.slice(0, star);
  const suf = p.slice(star + 1);
  return s.length >= pre.length + suf.length && s.startsWith(pre) && s.endsWith(suf);
}

// Override text is printed into generated Markdown, so control characters (line breaks above all) are refused.
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_DETECT_ITEMS = 20;
const DETECT_LISTS = ['gradle', 'plugins', 'imports', 'files', 'content', 'manifest'];

/** Collapses every whitespace run to one space, for override text printed into a Markdown line. */
export const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Walks string leaves of a JSON value; calls fn(string). */
function eachString(v, fn) {
  if (typeof v === 'string') fn(v);
  else if (Array.isArray(v)) for (const x of v) eachString(x, fn);
  else if (isObj(v)) for (const x of Object.values(v)) eachString(x, fn);
}

/** Extra rules for an override entry, beyond validateEntry. Errors are not prefixed. */
function safetyErrors(dimId, e) {
  const errs = [];
  const where = `${dimId}.${e.id}`;
  let tooLong = false;
  eachString(e, (s) => {
    if (s.length > MAX_STRING) tooLong = true;
  });
  if (tooLong) errs.push(`${where}: strings must be at most ${MAX_STRING} characters`);
  let control = false;
  eachString(e, (s) => {
    if (CONTROL.test(s)) control = true;
  });
  if (control) errs.push(`${where}: strings may not contain control characters (such as line breaks)`);
  const detect = isObj(e.detect) ? e.detect : {};
  for (const key of DETECT_LISTS) {
    if (Array.isArray(detect[key]) && detect[key].length > MAX_DETECT_ITEMS) {
      errs.push(`${where}: detect.${key} has more than ${MAX_DETECT_ITEMS} items`);
    }
  }
  if (detect.computed !== undefined) errs.push(`${where}: detect.computed is not allowed in overrides`);
  for (const g of Array.isArray(detect.files) ? detect.files : []) {
    const p = globProblem(g);
    if (p) errs.push(`${where}: detect.files glob ${p}`);
  }
  for (const c of Array.isArray(detect.content) ? detect.content : []) {
    if (!isObj(c)) continue;
    if (c.regex !== undefined) errs.push(`${where}: detect.content regex is not allowed in overrides; use { "contains": "<literal>" }`);
    for (const k of Object.keys(c)) {
      if (k !== 'regex' && k !== 'glob' && k !== 'contains') errs.push(`${where}: detect.content has unknown key "${k}"`);
    }
    if (c.contains === undefined) {
      if (c.regex === undefined) errs.push(`${where}: detect.content item needs contains`);
    } else if (typeof c.contains !== 'string' || c.contains.length < 1 || c.contains.length > MAX_PATTERN) {
      errs.push(`${where}: detect.content contains must be 1..${MAX_PATTERN} characters`);
    }
    if (c.glob !== undefined) {
      const p = globProblem(c.glob);
      if (p) errs.push(`${where}: detect.content glob ${p}`);
    }
  }
  return errs;
}

function readOverrideFile(abs, name) {
  const st = fs.lstatSync(abs);
  if (!st.isFile()) throw new Error('must be a regular file (symlinks are not followed)');
  if (st.size > MAX_FILE_BYTES) throw new Error(`is larger than ${MAX_FILE_BYTES} bytes`);
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`is not valid JSON (${err.message})`);
  }
}

/**
 * Read and validate every *.json file of `dir` (sorted; README.md and other files are skipped) against the base catalog.
 * Returns { entries: [{ file, dimension, entry }], status: [{ file, dimension, id, status, reason }], files }.
 * Throws CatalogError listing every problem, each prefixed with its file name.
 */
export function loadOverrides(dir, base = loadCatalog()) {
  const empty = { entries: [], status: [], files: [] };
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch (err) {
    if (err.code === 'ENOENT') return empty;
    throw new CatalogError([`${OVERRIDES_DIR}: cannot read the folder (${err.code ?? err.message}); it must be a directory`]);
  }
  if (names.length > MAX_FILES) throw new CatalogError([`${OVERRIDES_DIR}: too many override files (${names.length}, at most ${MAX_FILES})`]);
  const errs = [];
  const docs = [];
  for (const name of names) {
    try {
      const doc = readOverrideFile(path.join(dir, name), name);
      if (!isObj(doc)) errs.push(`${name}: must be a JSON object`);
      else if (doc.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
        errs.push(`${name}: unsupported schemaVersion ${JSON.stringify(doc.schemaVersion)} (supported: ${SUPPORTED_SCHEMA_VERSION})`);
      } else docs.push({ name, doc });
    } catch (err) {
      errs.push(`${name}: ${err.message}`);
    }
  }

  // Pass 1: structure and ids, so successors and prerequisites may reference entries of any override file.
  const added = new Map(); // dimId -> Set(ids)
  const items = [];
  for (const { name, doc } of docs) {
    const entries = doc.entries ?? [];
    if (!Array.isArray(entries)) { errs.push(`${name}: entries must be an array`); continue; }
    if (entries.length > MAX_ENTRIES_PER_FILE) {
      errs.push(`${name}: too many entries (${entries.length}, at most ${MAX_ENTRIES_PER_FILE})`);
      continue;
    }
    for (const [i, item] of entries.entries()) {
      if (!isObj(item) || !isStr(item.dimension) || !isObj(item.entry)) {
        errs.push(`${name}: entries[${i}] needs dimension and entry`);
        continue;
      }
      const { dimension, entry } = item;
      if (!base.dimensions.some((d) => d.id === dimension)) {
        errs.push(`${name}: entries[${i}] unknown dimension "${dimension}" (overrides cannot add dimensions)`);
        continue;
      }
      if (!isStr(entry.id)) { errs.push(`${name}: entries[${i}] entry needs an id`); continue; }
      if (base.entry(dimension, entry.id) || added.get(dimension)?.has(entry.id)) {
        errs.push(`${name}: ${dimension}.${entry.id} already exists (overrides can only add new entries)`);
        continue;
      }
      if (!added.has(dimension)) added.set(dimension, new Set());
      added.get(dimension).add(entry.id);
      items.push({ file: name, dimension, entry });
    }
  }

  // Pass 2: per-entry rules (the catalog's own), safety rules, then cycles among override entries.
  const ctx = {
    allowComputed: false,
    hasDimension: (id) => base.dimensions.some((d) => d.id === id),
    hasEntry: (dim, id) => base.entry(dim, id) !== undefined || added.get(dim)?.has(id) === true,
  };
  for (const { file, dimension, entry } of items) {
    for (const m of [...validateEntry(dimension, entry, ctx), ...safetyErrors(dimension, entry)]) errs.push(`${file}: ${m}`);
  }
  for (const [dim, ids] of added) {
    const graph = new Map(items.filter((x) => x.dimension === dim).map((x) => [x.entry.id, x]));
    const state = new Map();
    const visit = (id, stack) => {
      if (!ids.has(id) || state.get(id) === 2) return;
      if (state.get(id) === 1) {
        errs.push(`${graph.get(id).file}: ${dim}: successor cycle ${[...stack.slice(stack.indexOf(id)), id].join(' -> ')}`);
        return;
      }
      state.set(id, 1);
      for (const s of Array.isArray(graph.get(id).entry.successors) ? graph.get(id).entry.successors : []) visit(s, [...stack, id]);
      state.set(id, 2);
    };
    for (const id of graph.keys()) visit(id, []);
  }

  // Status pins: base or override entries only.
  const status = [];
  for (const { name, doc } of docs) {
    const pins = doc.status ?? [];
    if (!Array.isArray(pins)) { errs.push(`${name}: status must be an array`); continue; }
    for (const [i, p] of pins.entries()) {
      if (!isObj(p) || !isStr(p.dimension) || !isStr(p.id) || !STATUSES.includes(p.status) || !isStr(p.reason)) {
        errs.push(`${name}: status[${i}] needs dimension, id, status (${STATUSES.join('|')}) and reason`);
      } else if (p.reason.length > MAX_STRING) {
        errs.push(`${name}: status[${i}] reason must be at most ${MAX_STRING} characters`);
      } else if ([p.dimension, p.id, p.reason].some((s) => CONTROL.test(s))) {
        errs.push(`${name}: status[${i}] strings may not contain control characters (such as line breaks)`);
      } else if (!ctx.hasEntry(p.dimension, p.id)) {
        errs.push(`${name}: status[${i}] unknown entry ${p.dimension}.${p.id}`);
      } else status.push({ file: name, dimension: p.dimension, id: p.id, status: p.status, reason: p.reason });
    }
  }
  if (errs.length) throw new CatalogError(errs);
  return { entries: items, status, files: docs.map((d) => d.name) };
}

/** A new catalog: base plus the override entries, with status pins applied. The base object is not modified. */
export function applyOverrides(catalog, overrides) {
  if (!overrides.entries.length && !overrides.status.length) return catalog;
  const dimensions = structuredClone(catalog.dimensions);
  const find = (dim) => dimensions.find((d) => d.id === dim);
  const addedList = [];
  for (const { dimension, entry } of overrides.entries) {
    const d = find(dimension);
    if (!d || d.entries.some((e) => e.id === entry.id)) throw new CatalogError([`${dimension}.${entry.id}: cannot add override entry`]);
    d.entries.push(structuredClone(entry));
    addedList.push(`${dimension}.${entry.id}`);
  }
  const pinned = [];
  const pins = {};
  for (const p of overrides.status) {
    const e = find(p.dimension)?.entries.find((x) => x.id === p.id);
    if (!e) throw new CatalogError([`${p.dimension}.${p.id}: cannot pin status of an unknown entry`]);
    e.status = p.status;
    e.statusPin = { reason: p.reason };
    pinned.push(`${p.dimension}.${p.id}`);
    pins[`${p.dimension}.${p.id}`] = { status: p.status, reason: p.reason };
  }
  return {
    ...catalog,
    catalogVersion: `${catalog.catalogVersion}+overrides`,
    baseCatalogVersion: catalog.catalogVersion,
    dimensions,
    entry: (dimId, entryId) => dimensions.find((d) => d.id === dimId)?.entries.find((e) => e.id === entryId),
    overridden: { added: addedList, statusPinned: [...new Set(pinned)], pins },
  };
}

/** The base catalog version, without the "+overrides" suffix a merged catalog carries. */
export const baseVersion = (catalog) => catalog.baseCatalogVersion ?? catalog.catalogVersion;

/**
 * Where the overrides of `root` live, as { dir, label, filePrefix }. A workspace member (manifest.workspace.role
 * "member", or the given `workspace`) inherits the hub's <hub>/.ai/catalog-overrides; a missing hub directory throws.
 * `label` prefixes error messages (null: the bare file name), `filePrefix` the reported file names (null: bare names).
 * `workspace` undefined means "read it from <root>/.ai/manifest.json"; null means standalone.
 */
export function overrideSource(root, workspace) {
  if (workspace === undefined) {
    try {
      workspace = readManifest(path.join(root, '.ai'))?.workspace ?? null;
    } catch {
      workspace = null; // an unreadable manifest is reported by the commands that need it
    }
  }
  const own = path.join(root, '.ai', OVERRIDES_DIR);
  if (workspace?.role === 'member' && typeof workspace.hub === 'string') {
    const label = `${workspace.hub}/.ai/${OVERRIDES_DIR}`;
    const hubAbs = path.resolve(root, workspace.hub);
    let found = false;
    try {
      found = fs.statSync(hubAbs).isDirectory();
    } catch {
      found = false;
    }
    if (!found) {
      throw new CatalogError([
        `${label}: workspace hub not found (this member's .ai/manifest.json points at ${workspace.hub}); restore the hub repo there or run init again from the hub`,
      ]);
    }
    return { dir: path.join(hubAbs, '.ai', OVERRIDES_DIR), label, filePrefix: label };
  }
  if (workspace?.role === 'hub') return { dir: own, label: `${path.basename(path.resolve(root))}/.ai/${OVERRIDES_DIR}`, filePrefix: null };
  return { dir: own, label: null, filePrefix: null };
}

/** Rewrites "<name>: ..." and "catalog-overrides: ..." messages as "<label>/<name>: ..." and "<label>: ...". */
function relabel(err, label) {
  if (!label || !(err instanceof CatalogError)) return err;
  return new CatalogError(err.errors.map((e) => (e.startsWith(`${OVERRIDES_DIR}:`) ? label + e.slice(OVERRIDES_DIR.length) : `${label}/${e}`)));
}

/**
 * Load the base catalog and, unless `overrides` is false, merge the project's catalog overrides when they exist: its own
 * .ai/catalog-overrides, or the hub's for a workspace member (see overrideSource; `workspace` as there).
 * Returns { catalog, base, files } (files: the override file names applied, hub-relative paths for a member; empty when none).
 */
export function loadCatalogWithOverrides(catalogDir, root, { overrides = true, workspace } = {}) {
  const base = catalogDir === undefined ? loadCatalog() : loadCatalog(catalogDir);
  if (!overrides) return { catalog: base, base, files: [] };
  const { dir, label, filePrefix } = overrideSource(root, workspace);
  if (!fs.existsSync(dir)) return { catalog: base, base, files: [] };
  let loaded;
  try {
    loaded = loadOverrides(dir, base);
  } catch (err) {
    throw relabel(err, label);
  }
  const files = filePrefix ? loaded.files.map((f) => `${filePrefix}/${f}`) : loaded.files;
  return { catalog: applyOverrides(base, loaded), base, files };
}
