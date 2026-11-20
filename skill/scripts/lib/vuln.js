import { compareVersions } from './version.js';

const CMP_RE = /^(<=|>=|<|>|=)(\d+(?:\.\d+)*)$/;
const PRE_RE = /^[-._]?(?:alpha|beta|rc|cr|m\d+|milestone|snapshot|dev|preview|ea)(?![a-z])/i;
const SPLIT_RE = /^(\d+(?:\.\d+)*)(.*)$/s;
// A concrete version: numeric dotted core plus an optional plain qualifier.
// Dynamic selectors (`2.+`, `latest.release`, `[2.8,3.0)`) never match.
const CONCRETE_RE = /^\d+(?:\.\d+)*(?:[-._][A-Za-z0-9][A-Za-z0-9._-]*)?$/;

/** Vulnerability-matching comparator: like compareVersions, but pre-releases sort below the release. */
function compareForVuln(a, b) {
  const [, ca = '0', qa = ''] = SPLIT_RE.exec(String(a)) ?? [];
  const [, cb = '0', qb = ''] = SPLIT_RE.exec(String(b)) ?? [];
  const c = compareVersions(ca, cb);
  if (c !== 0) return c;
  const pa = PRE_RE.test(qa);
  const pb = PRE_RE.test(qb);
  return pa === pb ? 0 : pa ? -1 : 1;
}

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
 * `-android`/`-jre`/`.Final` equal the release, while pre-release qualifiers
 * (alpha, beta, rc, cr, mN, milestone, snapshot, dev, preview, ea) sort strictly
 * below it, so `2.8.9-rc1` matches `<2.8.9`. Anything else, including empty groups, throws.
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
  return (version) => groups.some((g) => g.every((c) => c.test(compareForVuln(version, c.version))));
}

/**
 * Match build-unit dependencies against catalog `vulnerableVersions`.
 * `units` are `{ file, build }` (modules plus the root build file). Rows are
 * one per unit per dependency. A dependency whose version is missing,
 * unresolved or dynamic is never reported safe: its coord goes to
 * `unresolvedChecks`. Bundles are checked through their libraries. Alias/bundle
 * dependencies with unknown coordinates (a bundle: any of its libraries) go to
 * `unresolvedAliases` (only when the catalog has advisories).
 */
export function vulnerableDependencies(units, catalog) {
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
  const aliases = new Map();
  if (advisories.size === 0) return { vulnerable, unresolvedChecks: [], unresolvedAliases: [] };
  const addAlias = (dep, file) => aliases.set(`${dep.alias}\0${file}\0${dep.line}`, { alias: dep.alias, file, line: dep.line });
  for (const u of units) {
    // A version-catalog bundle is checked through its libraries; it is unresolved only when one of them is unknown.
    const deps = (u.build?.dependencies ?? []).flatMap((dep) => {
      if (!dep.bundle) return [dep];
      if (!dep.bundle.complete) addAlias(dep, u.file);
      return dep.bundle.members.map((m) => ({ ...m, line: dep.line }));
    });
    for (const dep of deps) {
      if (!dep.group || !dep.name) {
        if (dep.alias && !dep.project) addAlias(dep, u.file);
        continue;
      }
      const coord = `${dep.group}:${dep.name}`;
      const list = advisories.get(coord);
      if (!list) continue;
      if (dep.unresolved || typeof dep.version !== 'string' || !CONCRETE_RE.test(dep.version)) {
        unresolved.add(coord);
        continue;
      }
      for (const a of list) {
        if (!a.matches(dep.version)) continue;
        vulnerable.push({
          coord, version: dep.version, file: u.file, line: dep.line, entry: a.entry, dimension: a.dimension,
          id: a.adv.id, severity: a.adv.severity, summary: a.adv.summary, source: a.adv.source,
        });
      }
    }
  }
  const unresolvedAliases = [...aliases.values()].sort((x, y) =>
    x.alias < y.alias ? -1 : x.alias > y.alias ? 1 : x.file < y.file ? -1 : x.file > y.file ? 1 : (x.line ?? 0) - (y.line ?? 0));
  return { vulnerable, unresolvedChecks: [...unresolved].sort(), unresolvedAliases };
}
