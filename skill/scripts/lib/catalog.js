import fs from 'node:fs';

export const SUPPORTED_SCHEMA_VERSION = 1;
const STATUSES = ['current', 'legacy', 'deprecated'];
const DATE_RE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
const DETECT_LISTS = ['gradle', 'plugins', 'imports', 'files', 'content', 'manifest'];
const DEFAULT_DIR = new URL('../../catalog/', import.meta.url);

export class CatalogError extends Error {
  constructor(errors) {
    super(`Invalid catalog:\n- ${errors.join('\n- ')}`);
    this.name = 'CatalogError';
    this.errors = errors;
  }
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateDetect(where, detect, errs) {
  if (!isObj(detect)) {
    errs.push(`${where}: detect must be an object`);
    return;
  }
  let signals = 0;
  for (const key of DETECT_LISTS) {
    if (detect[key] === undefined) continue;
    if (!Array.isArray(detect[key])) {
      errs.push(`${where}: detect.${key} must be an array`);
      continue;
    }
    signals += detect[key].length;
    for (const item of detect[key]) {
      if (key === 'gradle') {
        if (!isObj(item) || !isStr(item.coord)) errs.push(`${where}: detect.gradle item needs coord`);
        else if (item.minVersion !== undefined && !/^\d+(\.\d+)*$/.test(item.minVersion)) {
          errs.push(`${where}: detect.gradle bad minVersion "${item.minVersion}"`);
        }
      } else if (key === 'content') {
        if (!isObj(item) || !isStr(item.glob) || !isStr(item.regex)) {
          errs.push(`${where}: detect.content item needs glob and regex`);
        } else {
          try { new RegExp(item.regex); } catch { errs.push(`${where}: detect.content invalid regex "${item.regex}"`); }
        }
      } else if (!isStr(item)) {
        errs.push(`${where}: detect.${key} items must be non-empty strings`);
      }
    }
  }
  if (detect.computed !== undefined && typeof detect.computed !== 'boolean') {
    errs.push(`${where}: detect.computed must be boolean`);
  } else if (detect.computed === true) {
    signals += 1;
  }
  if (signals === 0) errs.push(`${where}: no detect signals`);
}

export function validateCatalog(raw) {
  const errs = [];
  const meta = raw?.meta;
  const dims = raw?.dimensions;
  if (!isObj(meta)) return ['meta must be an object'];
  if (meta.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    errs.push(`unsupported schemaVersion ${JSON.stringify(meta.schemaVersion)} (supported: ${SUPPORTED_SCHEMA_VERSION})`);
  }
  if (!isStr(meta.catalogVersion)) errs.push('meta.catalogVersion must be a non-empty string');
  if (!isStr(meta.asOf)) errs.push('meta.asOf must be a non-empty string');
  if (!Array.isArray(dims)) return [...errs, 'dimensions must be an array'];

  const index = new Map();
  for (const d of dims) {
    if (!isObj(d) || !isStr(d.id) || !Array.isArray(d.entries)) {
      errs.push('dimension must have id and entries');
      continue;
    }
    if (index.has(d.id)) errs.push(`duplicate dimension id "${d.id}"`);
    const ids = new Set();
    for (const e of d.entries) {
      if (isObj(e) && isStr(e.id)) {
        if (ids.has(e.id)) errs.push(`${d.id}: duplicate entry id "${e.id}"`);
        ids.add(e.id);
      }
    }
    index.set(d.id, ids);
  }

  for (const d of dims) {
    if (!isObj(d) || !Array.isArray(d.entries)) continue;
    const graph = new Map();
    for (const e of d.entries) {
      if (!isObj(e) || !isStr(e.id)) {
        errs.push(`${d.id}: entry must have an id`);
        continue;
      }
      const where = `${d.id}.${e.id}`;
      if (!isStr(e.name)) errs.push(`${where}: name required`);
      if (!Number.isInteger(e.era) || e.era < 1) errs.push(`${where}: era must be an integer >= 1`);
      if (!STATUSES.includes(e.status)) errs.push(`${where}: bad status "${e.status}"`);
      for (const k of ['since', 'deprecatedSince']) {
        if (e[k] !== undefined && !(typeof e[k] === 'string' && DATE_RE.test(e[k]))) {
          errs.push(`${where}: ${k} must be YYYY or YYYY-MM`);
        }
      }
      if (e.policy !== undefined && !isObj(e.policy)) errs.push(`${where}: policy must be an object`);
      if (!Array.isArray(e.successors)) {
        errs.push(`${where}: successors must be an array`);
      } else {
        graph.set(e.id, e.successors);
        for (const s of e.successors) {
          if (!index.get(d.id).has(s)) errs.push(`${where}: unknown successor "${s}"`);
        }
      }
      if (e.prerequisites !== undefined) {
        if (!Array.isArray(e.prerequisites)) errs.push(`${where}: prerequisites must be an array`);
        else {
          for (const p of e.prerequisites) {
            if (!isObj(p) || !Array.isArray(p.anyOf)) {
              errs.push(`${where}: prerequisite needs dimension and anyOf`);
            } else if (!index.has(p.dimension)) {
              errs.push(`${where}: prerequisite references unknown dimension "${p.dimension}"`);
            } else {
              for (const x of p.anyOf) {
                if (!index.get(p.dimension).has(x)) {
                  errs.push(`${where}: prerequisite references unknown entry "${x}" in "${p.dimension}"`);
                }
              }
            }
          }
        }
      }
      validateDetect(where, e.detect, errs);
    }
    // Cycle detection by DFS over successors.
    const state = new Map();
    const visit = (id, stack) => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) {
        errs.push(`${d.id}: successor cycle ${[...stack.slice(stack.indexOf(id)), id].join(' -> ')}`);
        return;
      }
      state.set(id, 1);
      for (const s of graph.get(id) ?? []) if (graph.has(s)) visit(s, [...stack, id]);
      state.set(id, 2);
    };
    for (const id of graph.keys()) visit(id, []);
  }
  return errs;
}

export function loadCatalog(dir = DEFAULT_DIR) {
  const base = dir instanceof URL ? dir : new URL(`file://${String(dir).replace(/\/?$/, '/')}`);
  const readJson = (rel) => {
    try {
      return JSON.parse(fs.readFileSync(new URL(rel, base), 'utf8'));
    } catch (err) {
      throw new CatalogError([`cannot read ${rel}: ${err.message}`]);
    }
  };
  const meta = readJson('catalog.json');
  const names = Array.isArray(meta.dimensions) ? meta.dimensions : [];
  const dimensions = names.map((n) => readJson(`dimensions/${n}.json`));
  const errors = validateCatalog({ meta, dimensions });
  if (errors.length) throw new CatalogError(errors);
  return {
    schemaVersion: meta.schemaVersion,
    catalogVersion: meta.catalogVersion,
    asOf: meta.asOf,
    dimensions,
    entry(dimId, entryId) {
      return dimensions.find((d) => d.id === dimId)?.entries.find((e) => e.id === entryId);
    },
  };
}
