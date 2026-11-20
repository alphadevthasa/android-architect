import { loadCatalog } from './catalog.js';
import { findingCountLines } from './security.js';
import { mdText } from './mdtext.js';

const pct = (share, units) => (Math.round(share * 100) === 0 && units > 0 ? '<1%' : `${Math.round(share * 100)}%`);
const PERF_LABELS = {
  'org.gradle.configuration-cache': 'org.gradle.configuration-cache',
  'org.gradle.caching': 'org.gradle.caching',
  'org.gradle.parallel': 'org.gradle.parallel',
  'android.nonTransitiveRClass': 'android.nonTransitiveRClass',
  kapt: 'kapt',
  'kotlin-version': 'Kotlin version',
  'agp-version': 'Android Gradle Plugin version',
  'gradle-version': 'Gradle version',
};

/** One Markdown line for a profile.buildPerformance item; file and detail are untrusted text. */
export function buildPerfLine(i) {
  const at = i.file ? ` [${mdText(i.line === null ? i.file : `${i.file}:${i.line}`)}]` : '';
  return `- ${PERF_LABELS[i.id] ?? mdText(i.id)}: ${i.status} (${mdText(i.detail)})${at}`;
}
// Every project-derived string (paths, coordinates, details) passes through mdText: file names may hold line breaks.
const where = (e) => mdText(e.line === null || e.line === undefined ? e.file : `${e.file}:${e.line}`);

/**
 * Render a StackProfile as Markdown. Dimension and entry names come from the
 * catalog (the bundled one by default).
 */
export function renderProfileMarkdown(profile, catalog = loadCatalog()) {
  const dimName = (id) => catalog.dimensions.find((d) => d.id === id)?.name ?? id;
  const entryName = (dimId, id) => catalog.entry(dimId, id)?.name ?? id;
  const out = ['# Android stack profile', ''];
  const { sdk, size } = profile;
  out.push(`- Catalog: ${profile.catalogVersion}`);
  out.push(`- SDK: min ${sdk.minSdk ?? '?'}, target ${sdk.targetSdk ?? '?'}, compile ${sdk.compileSdk ?? '?'}`);
  out.push(`- Size: ${size.files} files, ${size.sourceFiles} source files (${size.kotlinFiles} Kotlin, ${size.javaFiles} Java), ${size.xmlLayouts} XML layouts, ${size.loc} LOC`);
  out.push(`- Modules: ${profile.modules.map((m) => mdText(m.path)).join(', ') || 'none'}`);
  for (const [dimId, { entries }] of Object.entries(profile.dimensions)) {
    out.push('', `## ${dimName(dimId)}`, '');
    if (entries.length === 0) {
      out.push('- not detected');
      continue;
    }
    for (const e of entries) {
      const ev = e.evidence.length ? ` (evidence: ${e.evidence.map(where).join(', ')})` : '';
      out.push(`- ${entryName(dimId, e.id)}: ${e.share === null ? 'present' : pct(e.share, e.units)}${ev}`);
    }
  }
  if (profile.compliance.length) {
    out.push('', `## ${dimName('compliance')}`, '');
    for (const c of profile.compliance) out.push(`- ${mdText(entryName('compliance', c.id))}: ${c.status} (${mdText(c.detail)})${c.source ? ` source: ${mdText(c.source)}` : ''}`);
  }
  const perf = profile.buildPerformance?.items ?? [];
  if (perf.length) {
    out.push('', '## Build performance checks', '');
    for (const i of perf) out.push(buildPerfLine(i));
  }
  const findings = profile.security?.findings ?? [];
  out.push('', '## Security', '');
  if (findings.length === 0) out.push('- no security signals found');
  out.push(...findingCountLines(profile.security));
  for (const f of findings) out.push(`- [${f.severity}] ${mdText(f.id)}: ${mdText(`${f.file}:${f.line}`)} (${mdText(f.detail)})`);
  for (const v of profile.security?.vulnerable ?? []) {
    out.push(`- [${v.severity}] ${mdText(v.id)}: ${mdText(`${v.coord}:${v.version}`)} at ${mdText(`${v.file}:${v.line}`)} (${mdText(v.summary)}; ${mdText(v.source)})`);
  }
  for (const a of profile.security?.unresolvedAliases ?? []) out.push(`- cannot check (alias coordinates unresolved): ${mdText(a.alias)} at ${mdText(`${a.file}:${a.line}`)}`);
  for (const c of profile.security?.unresolvedChecks ?? []) out.push(`- not checked (version unresolved): ${mdText(c)}`);
  return out.join('\n') + '\n';
}
