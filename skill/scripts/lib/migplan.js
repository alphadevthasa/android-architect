// Migration plan skeleton: recommendations (validated by the caller) + feature map + reuse + playbooks -> ordered steps.
// Deterministic and bounded; the agent writes the prose. checkPlan verifies integrity (ids, dependsOn, acyclic, safety nets).
import { sanitizeName } from './features.js';
import { mdText, stripUnsafe } from './mdtext.js';
import { oneLine } from './overrides.js';

/** Dimensions whose recommendation steps are expanded once per feature (first, then next bucket). Others stay global. */
export const EXPAND_DIMENSIONS = ['ui', 'presentation', 'navigation'];
/** Dimensions scheduled as the data track when a playbook matches. */
export const DATA_DIMENSIONS = ['persistence', 'keyvalue', 'networking', 'serialization'];
export const MAX_FEATURES = 40;
export const MAX_RECS_STEPS = 100;
export const MAX_PLAN_STEPS = 1000;
export const MAX_NOTES = 100;
const MAX_EVIDENCE_PATHS = 3;
const MAX_DEPS_SHOWN = 8;
const ID_RE = /^[a-z0-9:_.-]+$/;
const TAGS = ['irreversible', 'decision'];
const TRACKS = ['features', 'data', 'enabling'];
const UNIT_TEST_CMD = './gradlew testDebugUnitTest';

const clean = (s, n = 200) => oneLine(stripUnsafe(String(s ?? '')).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')).slice(0, n);
const idPart = (s) => clean(s, 60).toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
const isStr = (v) => typeof v === 'string' && v.length > 0;

function uniqueId(used, base) {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/**
 * Build the plan. `features` is the feature map ({ features }) or its array. Throws when the result fails checkPlan
 * or the input is too large to plan within the caps.
 */
export function buildPlan({ recs, features, reuse, playbooks, profile, catalog }) { // eslint-disable-line no-unused-vars
  const recSteps = Array.isArray(recs?.steps) ? recs.steps : [];
  if (recSteps.length > MAX_RECS_STEPS) throw new Error(`too many recommendation steps (${recSteps.length}, max ${MAX_RECS_STEPS})`);
  const notes = [];
  const note = (n) => notes.push(clean(n, 300));

  // Features: first, then next (map order is already bucket then score); last get a note.
  const all = Array.isArray(features) ? features : Array.isArray(features?.features) ? features.features : [];
  const usedFeat = new Set();
  const planned = [];
  let skipped = 0;
  for (const f of all) {
    const name = clean(f?.name ?? f?.id ?? 'unit', 60);
    if (f?.bucket === 'last') {
      note(`leave as is: ${name}`);
      continue;
    }
    if (f?.bucket !== 'first' && f?.bucket !== 'next') continue;
    if (planned.length >= MAX_FEATURES) {
      skipped++;
      continue;
    }
    const id = uniqueId(usedFeat, idPart(sanitizeName(f.id ?? f.name ?? '', planned.length)) || `unit-${planned.length + 1}`);
    planned.push({
      id, name, bucket: f.bucket, score: Number.isFinite(f.score) ? f.score : 0, risk: f.risk === 'high' ? 'high' : f.risk ?? 'low',
      paths: (Array.isArray(f.paths) ? f.paths : []).slice(0, MAX_EVIDENCE_PATHS).map((p) => clean(p, 120)),
    });
  }
  if (skipped > 0) note(`... and ${skipped} more features not planned (cap ${MAX_FEATURES}); plan them in a later round`);
  const nextCount = planned.filter((f) => f.bucket === 'next').length;
  if (nextCount > 0) note('next-bucket features get no safety-net step in this plan; add characterization and screenshot tests before migrating them');

  const dupHigh = reuse?.duplicationScore === 'medium' || reuse?.duplicationScore === 'high';
  const steps = [];
  const usedIds = new Set();
  const push = (s) => {
    s.id = s.id.toLowerCase();
    steps.push(s);
  };

  // Enabling: design-system extraction, then safety nets (filled in after we know which features have steps).
  const expandedSomewhere = recSteps.some((s) => EXPAND_DIMENSIONS.includes(s?.dimension)) && planned.length > 0;
  const needsNet = new Set(expandedSomewhere ? planned.filter((f) => f.bucket === 'first').map((f) => f.id) : []);
  if (dupHigh) {
    usedIds.add('extract:design-system');
    push({
      id: 'extract:design-system', title: 'Extract shared design-system components', track: 'enabling', dimension: 'ui', from: null, to: 'design-system',
      dependsOn: [], tags: [],
      verification: [`${UNIT_TEST_CMD} passes`, 'screenshot tests of the affected screens pass without unintended diffs'],
      rollback: 'Revert the pull request; screens keep using their local copies until each one is switched.',
      evidence: [`reuse: duplicationScore ${reuse.duplicationScore}`],
    });
  }
  for (const f of planned) {
    if (!needsNet.has(f.id)) continue;
    const id = `safety-net:${f.id}`;
    usedIds.add(id);
    push({
      id, title: `Safety net for ${f.name}: characterization and screenshot tests`, track: 'enabling', dimension: 'testing', from: null,
      to: 'characterization-tests', feature: f.id, dependsOn: [], tags: [],
      verification: [
        `unit tests pass (${UNIT_TEST_CMD}), including the new characterization tests`,
        'screenshot tests for the feature pass and their baselines are recorded before any migration change',
      ],
      rollback: 'Revert the pull request; the tests only add coverage.',
      evidence: [`feature-map: ${f.id} bucket ${f.bucket}, score ${f.score}`],
    });
  }

  // Recommendation steps in recs order (validated: dependsOn points to earlier steps).
  const expansions = new Map(); // recs id -> Map(featureId -> planId) ; global: string
  const globalId = new Map();
  const recIds = new Set();
  const baseOf = new Map(); // original recs id -> unique base
  for (const raw of recSteps) {
    if (!raw || !isStr(raw.id)) throw new Error('recommendation step without id');
    const dimension = idPart(raw.dimension);
    const from = raw.from === null ? null : idPart(raw.from);
    const to = idPart(raw.to);
    const base = uniqueId(recIds, idPart(raw.id).replace(/:/g, '-') || 'step');
    baseOf.set(raw.id, base);
    const direct = from !== null && (catalog?.entry?.(raw.dimension, raw.from)?.successors ?? []).includes(raw.to);
    const transitive = from !== null && !direct;
    const pb = from === null || transitive ? undefined
      : (playbooks ?? []).find((p) => p.dimension === raw.dimension && p.from === raw.from && p.to === raw.to);
    const label = `${dimension}: ${from ?? 'none'} -> ${to}`;
    if (!pb) {
      note(transitive ? `no playbook for ${label}: transitive hop, plan each hop separately`
        : `no playbook for ${label}: write the migration steps by hand`);
    }
    const srcTags = (Array.isArray(raw.tags) ? raw.tags : []).filter((t) => TAGS.includes(t));
    const tags = new Set(srcTags);
    if (pb?.irreversible) tags.add('irreversible');
    if (pb && pb.securityChecklist.length > 0) tags.add('decision');
    const title = pb ? clean(pb.title, 120) : label;
    const expand = EXPAND_DIMENSIONS.includes(raw.dimension) && planned.length > 0;
    const data = pb !== undefined && DATA_DIMENSIONS.includes(raw.dimension);
    const common = { dimension, from, to, ...(pb ? { playbook: pb.id } : {}) };
    const evidence = [`recs: ${base} (${label})`];
    if (pb) evidence.push(`playbook: ${pb.id} (verified: ${pb.verified === true})`);
    const verification = [`unit tests pass (${UNIT_TEST_CMD})`];
    if (EXPAND_DIMENSIONS.includes(raw.dimension)) verification.push('screenshot tests for the migrated screens pass');
    if (pb) verification.push(`the Tests section of playbook ${pb.id} is satisfied`);
    if (tags.has('irreversible')) verification.push('a restorable backup of on-device data exists before the first release that uses the new implementation');
    const rollback = pb ? `Follow the Rollback section of playbook ${pb.id}.${pb.irreversible ? ' Data moves one way once released; restore from the pre-release backup, never by a destructive fallback.' : ''}`
      : 'Revert the pull request; keep the old implementation until the new one is verified.';

    const mapDeps = (feature) => {
      const out = [];
      for (const d of Array.isArray(raw.dependsOn) ? raw.dependsOn : []) {
        const target = baseOf.get(d) ?? null;
        const ex = target === null ? undefined : expansions.get(target);
        if (ex) {
          if (feature !== null && ex.has(feature)) out.push(ex.get(feature));
          else out.push(...ex.values());
        } else if (target !== null && globalId.has(target)) out.push(globalId.get(target));
      }
      return out;
    };

    if (expand) {
      const m = new Map();
      for (const f of planned) {
        const id = uniqueId(usedIds, `${base}:${f.id}`);
        m.set(f.id, id);
        const deps = mapDeps(f.id);
        if (dupHigh && raw.dimension === 'ui') deps.push('extract:design-system');
        if (needsNet.has(f.id)) deps.push(`safety-net:${f.id}`);
        const t = new Set(tags);
        if (f.risk === 'high') t.add('decision');
        push({
          id, title: `${title} in ${f.name}`, track: 'feature', ...common, feature: f.id, dependsOn: [...new Set(deps)], tags: TAGS.filter((x) => t.has(x)),
          verification, rollback, evidence: [...evidence, `feature-map: ${f.id} bucket ${f.bucket}, score ${f.score}`, ...(f.paths.length ? [`paths: ${f.paths.join(', ')}`] : []), ...(f.risk === 'high' ? ['risk: high, ask before touching'] : [])],
        });
      }
      expansions.set(base, m);
    } else {
      if (EXPAND_DIMENSIONS.includes(raw.dimension)) note(`no features to expand for ${label}: kept as one global step`);
      const id = uniqueId(usedIds, base);
      globalId.set(base, id);
      push({
        id, title, track: data ? 'data' : EXPAND_DIMENSIONS.includes(raw.dimension) ? 'feature' : 'enabling', ...common,
        dependsOn: [...new Set(mapDeps(null))], tags: TAGS.filter((x) => tags.has(x)), verification, rollback, evidence,
      });
    }
  }

  for (const d of Array.isArray(recs?.dimensions) ? recs.dimensions : []) {
    if (d?.label === 'later' || d?.label === 'dont') {
      note(`${d.label}: ${clean(d.dimension, 40)} ${clean(d.target ?? 'current entry', 60)} (not planned)${d.label === 'dont' ? ' - keep as is' : ''}`);
    }
  }
  if (steps.length > MAX_PLAN_STEPS) throw new Error(`plan too large (${steps.length} steps, max ${MAX_PLAN_STEPS})`);

  const tracks = { features: [], data: [], enabling: [] };
  for (const s of steps) tracks[s.track === 'feature' ? 'features' : s.track].push(s.id);
  const shown = notes.slice(0, MAX_NOTES);
  if (notes.length > MAX_NOTES) shown.push(`... and ${notes.length - MAX_NOTES} more notes`);
  const plan = { schemaVersion: 1, steps, tracks, notes: shown };
  const problems = checkPlan(plan);
  if (problems.length > 0) throw new Error(`plan integrity check failed: ${problems.slice(0, 5).join('; ')}`);
  return plan;
}

/** Integrity problems of a plan (empty when fine): ids, dependsOn existence, acyclic, tracks, tags, safety-net ordering. */
export function checkPlan(plan) {
  const errs = [];
  const bad = (m) => errs.push(m);
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.steps)) return ['plan shape is invalid'];
  const byId = new Map();
  for (const s of plan.steps) {
    if (typeof s?.id !== 'string' || !ID_RE.test(s.id)) bad(`invalid step id ${JSON.stringify(String(s?.id).slice(0, 40))}`);
    else if (byId.has(s.id)) bad(`duplicate step id ${s.id}`);
    else byId.set(s.id, s);
  }
  const indeg = new Map();
  const users = new Map();
  for (const s of plan.steps) {
    if (!byId.has(s.id) || byId.get(s.id) !== s) continue;
    if (!Array.isArray(s.dependsOn)) { bad(`${s.id}: dependsOn must be an array`); continue; }
    if (!Array.isArray(s.tags) || s.tags.some((t) => !TAGS.includes(t))) bad(`${s.id}: invalid tags`);
    if (!['enabling', 'data', 'feature'].includes(s.track)) bad(`${s.id}: invalid track`);
    let n = 0;
    for (const d of new Set(s.dependsOn)) {
      if (d === s.id) bad(`${s.id}: depends on itself (cycle)`);
      else if (!byId.has(d)) bad(`${s.id}: dependsOn "${String(d).slice(0, 60)}" does not exist`);
      else {
        n++;
        if (!users.has(d)) users.set(d, []);
        users.get(d).push(s.id);
      }
    }
    indeg.set(s.id, n);
    if (s.id.startsWith('safety-net:')) {
      for (const d of s.dependsOn) if (byId.get(d) && byId.get(d).track !== 'enabling') bad(`${s.id}: a safety net may not depend on migration step ${d}`);
    }
    if (s.track === 'feature' && s.feature !== undefined && byId.has(`safety-net:${s.feature}`) && !s.dependsOn.includes(`safety-net:${s.feature}`)) {
      bad(`${s.id}: must depend on safety-net:${s.feature}`);
    }
  }
  // Kahn: every step must be reachable in a topological order.
  const queue = [...indeg].filter(([, n]) => n === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length > 0) {
    const id = queue.pop();
    seen++;
    for (const u of users.get(id) ?? []) {
      indeg.set(u, indeg.get(u) - 1);
      if (indeg.get(u) === 0) queue.push(u);
    }
  }
  if (seen < indeg.size) bad('dependsOn forms a cycle');
  // Tracks list every step exactly once and agree with step.track.
  const listed = new Map();
  for (const t of TRACKS) {
    for (const id of Array.isArray(plan.tracks?.[t]) ? plan.tracks[t] : []) {
      listed.set(id, (listed.get(id) ?? 0) + 1);
      const want = t === 'features' ? 'feature' : t;
      if (byId.has(id) && byId.get(id).track !== want) bad(`${id}: listed in tracks.${t} but track is ${byId.get(id).track}`);
    }
  }
  for (const id of byId.keys()) if (listed.get(id) !== 1) bad(`${id}: must be listed in exactly one track`);
  return errs;
}

/** Markdown table for migration/roadmap.md: every step as a `todo` row; text is sanitized. */
export function renderRoadmap(plan) {
  const rows = ['| Step | Description | Status |', '| --- | --- | --- |'];
  for (const s of plan.steps) {
    const tags = s.tags.map((t) => `[${t}]`).join(' ');
    const deps = s.dependsOn.slice(0, MAX_DEPS_SHOWN).map((d) => mdText(d));
    const more = s.dependsOn.length > MAX_DEPS_SHOWN ? ` and ${s.dependsOn.length - MAX_DEPS_SHOWN} more` : '';
    const parts = [mdText(s.title)];
    if (tags) parts.push(tags);
    if (deps.length > 0) parts.push(`(after: ${deps.join(', ')}${more})`);
    rows.push(`| \`${mdText(s.id).replace(/\\/g, '')}\` | ${parts.join(' ')} | todo |`);
  }
  return rows.join('\n') + '\n';
}
