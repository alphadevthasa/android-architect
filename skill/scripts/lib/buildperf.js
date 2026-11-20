// Build performance advice: gradle.properties switches, kapt with a catalog alternative, and the Kotlin version
// against the catalog's current Kotlin entry. Thresholds come from the catalog (no invented numbers): AGP and
// Gradle have no current-version entry, so they are reported `unknown`. A missing gradle.properties is `unknown`.
import path from 'node:path';
import { compareVersions } from './version.js';

export const KAPT_PLUGINS = new Set(['kotlin-kapt', 'org.jetbrains.kotlin.kapt']);
/** Kotlin version from which the catalog marks K2 as current (language.kotlin-k2). */
export const K2_MIN_VERSION = '2.0';
const PROPS = 'gradle.properties';

/** First kapt use across build units ({ file, line }) or null: the kapt plugin applied, or a kapt* dependency configuration. */
export function kaptUse(ctx) {
  for (const u of ctx.buildUnits) {
    const p = u.appliedPlugins.find((x) => KAPT_PLUGINS.has(x.id));
    if (p) return { file: u.file, line: p.line };
    const d = u.build.dependencies.find((x) => /^kapt/.test(x.configuration ?? ''));
    if (d) return { file: u.file, line: d.line };
  }
  return null;
}

/** Parse Java-properties lines: last assignment wins. Returns Map key -> { value, line }. */
function parseProps(lines) {
  const props = new Map();
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('!')) return;
    const eq = t.search(/[=:]/);
    if (eq <= 0) return;
    props.set(t.slice(0, eq).trim(), { value: t.slice(eq + 1).trim().toLowerCase(), line: i + 1 });
  });
  return props;
}

function findPropsFile(ctx) {
  const all = ctx.files.filter((f) => path.posix.basename(f) === PROPS);
  all.sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return all[0] ?? null;
}

const SWITCHES = [
  { id: 'org.gradle.configuration-cache', keys: ['org.gradle.configuration-cache', 'org.gradle.unsafe.configuration-cache'], advice: 'enable the Gradle configuration cache' },
  { id: 'org.gradle.caching', keys: ['org.gradle.caching'], advice: 'enable the Gradle build cache' },
  { id: 'org.gradle.parallel', keys: ['org.gradle.parallel'], advice: 'enable parallel project execution' },
  { id: 'android.nonTransitiveRClass', keys: ['android.nonTransitiveRClass'], absent: 'unknown', advice: 'use non-transitive R classes (newer AGP versions default to true, check the AGP version)' },
];

function switchItem(sw, file, props) {
  if (file === null || props === null) {
    return { id: sw.id, status: 'unknown', detail: `${PROPS} not found or not readable; ${sw.advice} there, cannot check`, file: null, line: null };
  }
  const found = sw.keys.map((k) => props.get(k)).filter(Boolean);
  const on = found.find((f) => f.value === 'true');
  if (on) return { id: sw.id, status: 'ok', detail: `${sw.keys.find((k) => props.get(k) === on)}=true`, file, line: on.line };
  if (found.length) {
    const last = found[found.length - 1];
    return { id: sw.id, status: 'gap', detail: `set to "${last.value.slice(0, 20)}"; ${sw.advice}`, file, line: last.line };
  }
  return { id: sw.id, status: sw.absent ?? 'gap', detail: `not set in ${file}; ${sw.advice}`, file, line: null };
}

function kotlinItem(ctx, catalog) {
  const k2 = catalog.dimensions.find((d) => d.id === 'language')?.entries.find((e) => e.id === 'kotlin-k2');
  const cands = [];
  for (const u of ctx.buildUnits) {
    for (const p of u.build.plugins) if (p.id.startsWith('org.jetbrains.kotlin') && p.version) cands.push({ file: u.file, line: p.line, version: p.version });
    for (const d of u.build.dependencies) if (d.group === 'org.jetbrains.kotlin' && d.version) cands.push({ file: u.file, line: d.line, version: d.version });
  }
  if (!k2 || k2.status !== 'current' || cands.length === 0) {
    return { id: 'kotlin-version', status: 'unknown', detail: 'Kotlin version not statically resolvable (or no current Kotlin entry in the catalog)', file: null, line: null };
  }
  const old = cands.find((c) => compareVersions(c.version, K2_MIN_VERSION) < 0);
  if (old) {
    return { id: 'kotlin-version', status: 'gap', detail: `Kotlin ${old.version} is older than ${K2_MIN_VERSION}, the version of the catalog's current entry "${k2.name}"`, file: old.file, line: old.line };
  }
  return { id: 'kotlin-version', status: 'ok', detail: `Kotlin ${cands[0].version} is at least ${K2_MIN_VERSION}`, file: cands[0].file, line: cands[0].line };
}

/** `profile.buildPerformance.items`: [{ id, status: ok|gap|unknown, detail, file, line|null }]. */
export function evaluateBuildPerformance(ctx, catalog) {
  const file = findPropsFile(ctx);
  const lines = file === null ? null : ctx.read(file);
  const props = lines ? parseProps(lines) : null;
  const items = SWITCHES.map((sw) => switchItem(sw, props ? file : null, props));
  const kapt = kaptUse(ctx);
  const alts = (catalog.dimensions.find((d) => d.id === 'build')?.entries.find((e) => e.id === 'kapt')?.successors ?? [])
    .map((id) => catalog.dimensions.find((d) => d.id === 'build')?.entries.find((e) => e.id === id))
    .filter((e) => e && e.status === 'current');
  if (alts.length > 0) {
    const names = alts.map((e) => e.name).join(', ');
    items.push(kapt
      ? { id: 'kapt', status: 'gap', detail: `kapt in use; the catalog alternative is ${names}`, file: kapt.file, line: kapt.line }
      : { id: 'kapt', status: 'ok', detail: 'no kapt use found', file: null, line: null });
  }
  items.push(kotlinItem(ctx, catalog));
  const none = 'the catalog has no current-version entry for it; check it manually';
  items.push({ id: 'agp-version', status: 'unknown', detail: `Android Gradle Plugin: ${none}`, file: null, line: null });
  items.push({ id: 'gradle-version', status: 'unknown', detail: `Gradle: ${none}`, file: null, line: null });
  return { items };
}
