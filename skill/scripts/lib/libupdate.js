// Library update planning: security fixes first, then routine updates by update group, majors last.
// Targets come only from versions.json (hand-maintained, possibly unverified); nothing here guesses a version.
import { vulnerableDependencies, compareForVuln, parseRange, CONCRETE_RE } from './vuln.js';
import { mdText } from './knowledge.js';

const DAY_MS = 86400000;
const MD_CAP = 300;
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const NO_FIX_NOTE = 'no fixed version known: check the advisory source';
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const numericCore = (v) => (/^\d+(?:\.\d+)*/.exec(String(v))?.[0] ?? '0').split('.').map(Number);

/** patch, minor or major from the numeric segments only: the first of major and minor that differs wins. */
function kindOf(current, target) {
  const a = numericCore(current);
  const b = numericCore(target);
  if ((a[0] ?? 0) !== (b[0] ?? 0)) return 'major';
  return (a[1] ?? 0) !== (b[1] ?? 0) ? 'minor' : 'patch';
}

const isoDay = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN);

function isStale(asOf, today, staleDays) {
  const a = isoDay(asOf);
  const t = isoDay(today);
  // Unparseable dates are treated as stale: the plan then asks for verification instead of trusting the data.
  return Number.isNaN(a) || Number.isNaN(t) || (t - a) / DAY_MS > staleDays;
}

function declarations(unit, modulePath) {
  const out = [];
  const cannot = [];
  const at = { module: modulePath, file: unit.file };
  for (const dep of unit.build?.dependencies ?? []) {
    if (dep.project) continue;
    if (dep.bundle) {
      if (!dep.bundle.complete) cannot.push({ ...at, coord: null, alias: dep.alias ?? null, line: dep.line, current: null, reason: 'bundle could not be fully resolved' });
      for (const m of dep.bundle.members) out.push({ ...at, ...m, line: dep.line });
      continue;
    }
    if (!dep.group || !dep.name) {
      if (dep.alias) cannot.push({ ...at, coord: null, alias: dep.alias, line: dep.line, current: null, reason: 'version-catalog alias could not be resolved' });
      continue;
    }
    out.push({ ...at, ...dep });
  }
  return { out, cannot };
}

/**
 * Plan library updates. `modules` are discoverModules results (they map build files to module paths); `opts.units`
 * are the build units to read (default: the modules' build files; pass detect's collectBuildUnits to include the
 * root build file). `opts.scope` limits the plan to one module path. Returns
 * { generatedAt, dataAsOf, stale, verified, catalogVersion, groups, cannotUpdate, notes }.
 */
export function planLibraryUpdates(profile, modules, catalog, versions, { today, staleDays = 90, units, scope } = {}) {
  const day = today ?? new Date().toISOString().slice(0, 10);
  const stale = isStale(versions.asOf, day, staleDays);
  const known = new Map(versions.libraries.map((l) => [l.coord, l]));
  const modOf = new Map(modules.filter((m) => m.buildFile).map((m) => [m.buildFile, m.path]));
  let all = (units ?? modules.filter((m) => m.buildFile).map((m) => ({ file: m.buildFile, build: m.build })))
    .map((u) => ({ unit: u, modulePath: modOf.get(u.file) ?? ':' }));
  if (scope !== undefined) all = all.filter((x) => x.modulePath === scope);

  const advisoryCoords = new Set();
  const ranges = new Map();
  for (const dim of catalog.dimensions) {
    for (const e of dim.entries) {
      for (const a of e.vulnerableVersions ?? []) {
        advisoryCoords.add(a.coord);
        ranges.set(`${a.coord}\0${a.id}`, a.range);
      }
    }
  }
  const vuln = vulnerableDependencies(all.map((x) => x.unit), catalog).vulnerable;
  const advisoryAt = new Map();
  for (const v of vuln) {
    const key = `${v.coord}\0${v.file}\0${v.line}`;
    if (!advisoryAt.has(key)) advisoryAt.set(key, []);
    advisoryAt.get(key).push(v);
  }
  for (const list of advisoryAt.values()) {
    list.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || byText(a.id, b.id));
  }

  const seen = new Set();
  const security = [];
  const routine = [];
  const cannotUpdate = [];
  const cannotSeen = new Set();
  const addCannot = (c) => {
    const key = `${c.coord ?? c.alias}\0${c.module}\0${c.file}\0${c.line}`;
    if (!cannotSeen.has(key)) {
      cannotSeen.add(key);
      cannotUpdate.push(c);
    }
  };

  for (const { unit, modulePath } of all) {
    const { out, cannot } = declarations(unit, modulePath);
    cannot.forEach(addCannot);
    for (const d of out) {
      const coord = `${d.group}:${d.name}`;
      const key = `${coord}\0${modulePath}\0${d.file}\0${d.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hasVersion = typeof d.version === 'string' && d.version !== '';
      if (d.unresolved || !hasVersion || !CONCRETE_RE.test(d.version)) {
        const why = d.unresolved ? 'unresolved version' : !hasVersion ? 'no version declared (managed by a BOM, platform or plugin)' : 'dynamic version';
        addCannot({
          module: modulePath, file: d.file, coord, line: d.line, current: hasVersion ? d.version : null,
          reason: advisoryCoords.has(coord) ? `${why}: advisory check not possible` : why,
        });
        continue;
      }
      const lib = known.get(coord);
      const advs = advisoryAt.get(`${coord}\0${d.file}\0${d.line}`);
      const newer = lib !== undefined && compareForVuln(lib.stable, d.version) > 0;
      const base = { coord, module: modulePath, file: d.file, line: d.line, current: d.version };
      if (advs !== undefined) {
        const top = advs[0];
        const fixed = newer && !advs.some((a) => ranges.get(`${coord}\0${a.id}`) !== undefined && rangeHits(ranges.get(`${coord}\0${a.id}`), lib.stable));
        const item = {
          ...base, target: fixed ? lib.stable : null, kind: fixed ? kindOf(d.version, lib.stable) : null, reason: 'security',
          advisory: { id: top.id, severity: top.severity, summary: top.summary, source: top.source },
          ...(lib?.requires ? { requires: lib.requires } : {}), verify: stale,
        };
        const notes = [];
        if (!fixed) notes.push(NO_FIX_NOTE);
        if (advs.length > 1) notes.push(`${advs.length - 1} more advisories cover this version`);
        if (notes.length > 0) item.note = notes.join('; ');
        security.push(item);
        continue;
      }
      if (lib === undefined) {
        addCannot({ module: modulePath, file: d.file, coord, line: d.line, current: d.version, reason: 'not in versions.json: no target known' });
        continue;
      }
      if (!newer) continue;
      const kind = kindOf(d.version, lib.stable);
      routine.push({
        ...base, group: lib.group, target: lib.stable, kind, reason: 'routine', ...(lib.requires ? { requires: lib.requires } : {}),
        ...(lib.notes ? { note: lib.notes } : {}),
        verify: stale || (kind === 'major' && !advisoryCoords.has(coord)),
      });
    }
  }

  const itemOrder = (a, b) => byText(a.coord, b.coord) || byText(a.module, b.module) || byText(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0);
  security.sort((a, b) => (SEVERITY_RANK[a.advisory.severity] ?? 9) - (SEVERITY_RANK[b.advisory.severity] ?? 9) || itemOrder(a, b));
  const groups = [];
  if (security.length > 0) groups.push({ id: 'security', phase: 'security', items: security });
  const byGroup = new Map();
  for (const it of routine.filter((i) => i.kind !== 'major')) {
    if (!byGroup.has(it.group)) byGroup.set(it.group, []);
    byGroup.get(it.group).push(it);
  }
  for (const id of [...byGroup.keys()].sort(byText)) groups.push({ id, phase: 'routine', items: byGroup.get(id).sort(itemOrder) });
  const majors = routine.filter((i) => i.kind === 'major').sort(itemOrder);
  if (majors.length > 0) groups.push({ id: 'major', phase: 'major', prerequisites: prerequisitesOf(majors), items: majors });
  cannotUpdate.sort((a, b) => byText(a.coord ?? a.alias ?? '', b.coord ?? b.alias ?? '') || byText(a.module, b.module) || byText(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0));

  const notes = [];
  if (versions.verified !== true) notes.push(`versions.json is unverified${versions.dataNote ? `: ${versions.dataNote}` : ''}; targets are not guaranteed to be the latest stable versions`);
  if (stale) notes.push(`versions.json data is dated ${versions.asOf}, more than ${staleDays} days before ${day}: verify every target against the library's release notes`);
  notes.push('requires entries are not compared with this project: check Kotlin, AGP and minSdk against them before each step');
  return { generatedAt: day, dataAsOf: versions.asOf, stale, verified: versions.verified === true, catalogVersion: profile?.catalogVersion ?? null, groups, cannotUpdate, notes };
}

function rangeHits(range, version) {
  try {
    return parseRange(range)(version);
  } catch {
    return true; // an unreadable range is never taken as a fix
  }
}

/** Requirements of the major updates, one row per distinct requirement, to be met before the updates themselves. */
function prerequisitesOf(majors) {
  const rows = new Map();
  for (const it of majors) {
    for (const [k, v] of Object.entries(it.requires ?? {})) {
      const requirement = k === 'minSdk' ? `minSdk >=${v}` : `${k} ${v}`;
      if (!rows.has(requirement)) rows.set(requirement, new Set());
      rows.get(requirement).add(it.coord);
    }
  }
  return [...rows.keys()].sort(byText).map((requirement) => ({ requirement, coords: [...rows.get(requirement)].sort(byText) }));
}

const TITLES = { security: 'Security updates', major: 'Major updates (after the steps above)' };
const cell = (s) => mdText(s ?? '-') || '-';
const loc = (i) => `${cell(i.file)}:${i.line ?? '-'}`;

function renderGroup(g, n) {
  const title = g.phase === 'routine' ? `Update group ${cell(g.id)}` : TITLES[g.phase];
  const out = [`## ${n}. ${title} (${g.items.length})`, ''];
  if (g.prerequisites?.length) {
    out.push('Before these updates, meet:', '');
    for (const p of g.prerequisites) out.push(`- ${cell(p.requirement)} (for ${p.coords.slice(0, 5).map(cell).join(', ')}${p.coords.length > 5 ? `, and ${p.coords.length - 5} more` : ''})`);
    out.push('');
  }
  const sec = g.phase === 'security';
  out.push(`| Library | Module | Current | Target | Kind | Verify | ${sec ? 'Advisory' : 'Requires'} | Location |`, '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const i of g.items.slice(0, MD_CAP)) {
    const extra = sec
      ? `${cell(i.advisory.id)} (${cell(i.advisory.severity)}): ${cell(i.advisory.summary)}${i.note ? ` [${cell(i.note)}]` : ''}`
      : cell(i.requires ? Object.entries(i.requires).map(([k, v]) => `${k} ${v}`).join(', ') : null);
    out.push(`| ${cell(i.coord)} | ${cell(i.module)} | ${cell(i.current)} | ${cell(i.target)} | ${cell(i.kind)} | ${i.verify ? 'yes' : 'no'} | ${extra} | ${loc(i)} |`);
  }
  if (g.items.length > MD_CAP) out.push('', `… and ${g.items.length - MD_CAP} more`);
  return out.concat('');
}

/** Markdown for a planLibraryUpdates result. Every dependency-derived string is sanitized. */
export function renderLibraryUpdates(plan) {
  const out = ['# Library update plan', '',
    `Generated ${cell(plan.generatedAt)}. Version data as of ${cell(plan.dataAsOf)}${plan.stale ? ' (stale)' : ''}; ${plan.verified ? 'verified' : 'unverified'}.`, ''];
  for (const n of plan.notes) out.push(`- ${cell(n)}`);
  out.push('');
  if (plan.groups.length === 0) out.push('No updates to plan.', '');
  plan.groups.forEach((g, i) => out.push(...renderGroup(g, i + 1)));
  out.push(`## Cannot update automatically (${plan.cannotUpdate.length})`, '');
  if (plan.cannotUpdate.length === 0) out.push('none');
  else {
    out.push('| Dependency | Module | Version | Reason | Location |', '| --- | --- | --- | --- | --- |');
    for (const c of plan.cannotUpdate.slice(0, MD_CAP)) {
      out.push(`| ${cell(c.coord ?? c.alias)} | ${cell(c.module)} | ${cell(c.current)} | ${cell(c.reason)} | ${loc(c)} |`);
    }
    if (plan.cannotUpdate.length > MD_CAP) out.push('', `… and ${plan.cannotUpdate.length - MD_CAP} more`);
  }
  return out.concat('').join('\n');
}
