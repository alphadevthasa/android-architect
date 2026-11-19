import { compareVersions } from './version.js';

const CMP_RE = /^(<=|>=|<|>|=)(\d+(?:\.\d+)*)$/;
const TEST = {
  '<': (c) => c < 0,
  '<=': (c) => c <= 0,
  '>': (c) => c > 0,
  '>=': (c) => c >= 0,
  '=': (c) => c === 0,
};

/**
 * Parse a version range into a predicate. Grammar: space-separated comparators
 * (`<X`, `<=X`, `>X`, `>=X`, `=X`, X numeric dotted) ANDed together; `||` ORs
 * groups. Versions compare numerically per segment; qualifiers are ignored, so
 * `2.8.9-rc1` equals `2.8.9`. Anything else, including empty groups, throws.
 */
export function parseRange(range) {
  if (typeof range !== 'string' || range.trim() === '') throw new Error(`invalid range "${String(range).slice(0, 60)}"`);
  const groups = range.split('||').map((g) => {
    const parts = g.trim().split(/\s+/);
    return parts.map((p) => {
      const m = CMP_RE.exec(p);
      if (!m) throw new Error(`invalid range "${String(range).slice(0, 60)}"`);
      return { test: TEST[m[1]], version: m[2] };
    });
  });
  return (version) => groups.some((g) => g.every((c) => c.test(compareVersions(version, c.version))));
}

/**
 * Match module dependencies against catalog `vulnerableVersions`.
 * Dependencies without a resolvable version are never reported as safe: their
 * coord goes to `unresolvedChecks` instead.
 */
export function vulnerableDependencies(modules, catalog) {
  const advisories = new Map();
  for (const dim of catalog.dimensions) {
    for (const entry of dim.entries) {
      for (const adv of entry.vulnerableVersions ?? []) {
        if (!advisories.has(adv.coord)) advisories.set(adv.coord, []);
        advisories.get(adv.coord).push({ adv, entry: entry.id, dimension: dim.id, matches: parseRange(adv.range) });
      }
    }
  }
  const vulnerable = [];
  const unresolved = new Set();
  if (advisories.size === 0) return { vulnerable, unresolvedChecks: [] };
  for (const m of modules) {
    for (const dep of m.build?.dependencies ?? []) {
      if (!dep.group || !dep.name) continue;
      const coord = `${dep.group}:${dep.name}`;
      const list = advisories.get(coord);
      if (!list) continue;
      if (dep.unresolved || dep.version === null || dep.version === undefined) {
        unresolved.add(coord);
        continue;
      }
      for (const a of list) {
        if (!a.matches(dep.version)) continue;
        vulnerable.push({
          coord, version: dep.version, file: m.buildFile, line: dep.line, entry: a.entry, dimension: a.dimension,
          id: a.adv.id, severity: a.adv.severity, summary: a.adv.summary, source: a.adv.source,
        });
      }
    }
  }
  return { vulnerable, unresolvedChecks: [...unresolved].sort() };
}
