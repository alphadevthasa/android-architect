// Validates agent recommendations against the catalog graph and the detected profile.
import { presentIds } from './candidates.js';

const LABELS = ['must', 'should', 'later', 'dont'];
const TAGS = ['irreversible', 'decision'];
const MIN_JUSTIFICATION = 20;
const isStr = (v) => typeof v === 'string' && v.length > 0;

function reachableFrom(catalog, dimId, from) {
  const seen = new Set();
  const queue = [from];
  while (queue.length) {
    for (const s of catalog.entry(dimId, queue.shift())?.successors ?? []) {
      if (!seen.has(s)) {
        seen.add(s);
        queue.push(s);
      }
    }
  }
  return seen;
}

export function checkRecommendations(recs, catalog, profile) {
  const violations = [];
  const add = (rule, message, extra = {}) => violations.push({ ...extra, rule, message });

  if (recs === null || typeof recs !== 'object' || Array.isArray(recs)) {
    add('R5-shape', 'recommendations must be an object');
    return { ok: false, violations };
  }
  if (recs.schemaVersion !== 1) add('R5-shape', `schemaVersion must be 1, got ${JSON.stringify(recs.schemaVersion)}`);
  if (recs.catalogVersion !== catalog.catalogVersion) {
    add('R5-shape', `catalogVersion "${recs.catalogVersion}" does not match loaded catalog "${catalog.catalogVersion}"`);
  }
  if (!isStr(recs.generatedAt)) add('R5-shape', 'generatedAt must be a non-empty string');
  if (!Array.isArray(recs.dimensions)) add('R5-shape', 'dimensions must be an array');
  if (!Array.isArray(recs.steps)) add('R5-shape', 'steps must be an array');

  const dimIds = new Set(catalog.dimensions.map((d) => d.id));
  const hasEntry = (dim, id) => catalog.entry(dim, id) !== undefined;

  for (const [i, d] of (Array.isArray(recs.dimensions) ? recs.dimensions : []).entries()) {
    const where = `dimensions[${i}]`;
    if (d === null || typeof d !== 'object') {
      add('R5-shape', `${where} must be an object`);
      continue;
    }
    const dimension = d.dimension;
    if (!isStr(dimension)) add('R5-shape', `${where}: dimension is required`);
    else if (!dimIds.has(dimension)) add('R4-unknown-id', `${where}: unknown dimension "${dimension}"`, { dimension });
    if (!LABELS.includes(d.label)) add('R5-shape', `${where}: label must be one of ${LABELS.join(', ')}, got ${JSON.stringify(d.label)}`, { dimension });
    if (!Array.isArray(d.current) || !d.current.every(isStr)) add('R5-shape', `${where}: current must be an array of strings`, { dimension });
    else if (dimIds.has(dimension)) {
      for (const id of d.current) {
        if (!hasEntry(dimension, id)) add('R4-unknown-id', `${where}: unknown entry "${id}" in current of "${dimension}"`, { dimension });
      }
    }
    if (d.target !== null && !isStr(d.target)) add('R5-shape', `${where}: target must be a string or null`, { dimension });
    else if (isStr(d.target) && dimIds.has(dimension) && !hasEntry(dimension, d.target)) {
      add('R4-unknown-id', `${where}: unknown target entry "${d.target}" in "${dimension}"`, { dimension });
    }
    if (!isStr(d.rationale)) add('R5-shape', `${where}: rationale is required`, { dimension });
  }

  const steps = Array.isArray(recs.steps) ? recs.steps : [];
  const byId = new Map();
  const index = new Map();
  steps.forEach((s, i) => {
    if (s && isStr(s.id) && !byId.has(s.id)) {
      byId.set(s.id, s);
      index.set(s.id, i);
    }
  });

  // Steps reachable via dependsOn (transitively), tolerant of cycles.
  const ancestors = (step) => {
    const seen = new Set();
    const stack = [...(Array.isArray(step.dependsOn) ? step.dependsOn : [])];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      stack.push(...(Array.isArray(byId.get(id).dependsOn) ? byId.get(id).dependsOn : []));
    }
    return [...seen].map((id) => byId.get(id));
  };

  steps.forEach((s, i) => {
    const where = `steps[${i}]`;
    if (s === null || typeof s !== 'object') {
      add('R5-shape', `${where} must be an object`);
      return;
    }
    const sid = s.id;
    const ref = { step: isStr(sid) ? sid : where };
    const label = `step "${ref.step}"`;
    let shapeOk = true;
    if (!isStr(sid)) { add('R5-shape', `${where}: id is required`, ref); shapeOk = false; }
    else if (byId.get(sid) !== s) add('R5-shape', `${label}: duplicate step id`, ref);
    if (!isStr(s.dimension)) { add('R5-shape', `${label}: dimension is required`, ref); shapeOk = false; }
    if (!(s.from === null || isStr(s.from))) { add('R5-shape', `${label}: from must be a string or null`, ref); shapeOk = false; }
    if (!isStr(s.to)) { add('R5-shape', `${label}: to is required`, ref); shapeOk = false; }
    if (!Array.isArray(s.dependsOn) || !s.dependsOn.every(isStr)) { add('R5-shape', `${label}: dependsOn must be an array of strings`, ref); shapeOk = false; }
    if (s.justification !== undefined && typeof s.justification !== 'string') add('R5-shape', `${label}: justification must be a string`, ref);
    if (s.tags !== undefined) {
      if (!Array.isArray(s.tags) || s.tags.some((t) => !TAGS.includes(t))) {
        add('R5-shape', `${label}: tags may only contain ${TAGS.join(', ')}`, ref);
      }
    }

    // R3: dependsOn ordering and cycles.
    for (const dep of Array.isArray(s.dependsOn) ? s.dependsOn : []) {
      if (!byId.has(dep)) add('R3-order', `${label}: dependsOn "${dep}" does not exist`, ref);
      else if (index.get(dep) >= i) add('R3-order', `${label}: dependsOn "${dep}" must point to an earlier step`, ref);
    }
    if (isStr(sid) && ancestors(s).includes(s)) add('R3-order', `${label}: dependsOn forms a cycle`, ref);

    if (!shapeOk) return;

    // R4: unknown ids.
    if (!dimIds.has(s.dimension)) {
      add('R4-unknown-id', `${label}: unknown dimension "${s.dimension}"`, ref);
      return;
    }
    let idsOk = true;
    for (const [field, id] of [['from', s.from], ['to', s.to]]) {
      if (id !== null && !hasEntry(s.dimension, id)) {
        add('R4-unknown-id', `${label}: unknown entry "${id}" (${field}) in dimension "${s.dimension}"`, { ...ref, dimension: s.dimension });
        idsOk = false;
      }
    }
    if (!idsOk) return;

    // R1: hop legality.
    if (s.from === null) {
      if (catalog.entry(s.dimension, s.to).status !== 'current') {
        add('R1-hop', `${label}: entry "${s.to}" in "${s.dimension}" is not current, so it cannot be a fresh target`, { ...ref, dimension: s.dimension });
      }
    } else if (!(catalog.entry(s.dimension, s.from).successors ?? []).includes(s.to)) {
      if (!reachableFrom(catalog, s.dimension, s.from).has(s.to)) {
        add('R1-hop', `${label}: "${s.to}" is not reachable from "${s.from}" in "${s.dimension}"`, { ...ref, dimension: s.dimension });
      } else if (typeof s.justification !== 'string' || s.justification.trim().length < MIN_JUSTIFICATION) {
        add('R1-hop', `${label}: "${s.from}" -> "${s.to}" skips intermediate entries in "${s.dimension}"; a justification of at least ${MIN_JUSTIFICATION} characters is required`, { ...ref, dimension: s.dimension });
      }
    }

    // R2: prerequisites.
    const deps = ancestors(s);
    for (const p of catalog.entry(s.dimension, s.to).prerequisites ?? []) {
      const present = presentIds(profile, p.dimension);
      const met = p.anyOf.some((id) => present.has(id))
        || deps.some((d) => d.dimension === p.dimension && p.anyOf.includes(d.to));
      if (!met) {
        add('R2-prereq', `${label}: "${s.to}" in "${s.dimension}" requires one of [${p.anyOf.join(', ')}] in "${p.dimension}", which is neither present in the profile nor produced by a step in dependsOn`, { ...ref, dimension: s.dimension });
      }
    }
  });

  return { ok: violations.length === 0, violations };
}
