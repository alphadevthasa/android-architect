import { loadCatalog } from './catalog.js';

const pct = (share, units) => (Math.round(share * 100) === 0 && units > 0 ? '<1%' : `${Math.round(share * 100)}%`);
const where = (e) => (e.line === null || e.line === undefined ? e.file : `${e.file}:${e.line}`);

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
  out.push(`- Modules: ${profile.modules.map((m) => m.path).join(', ') || 'none'}`);
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
    for (const c of profile.compliance) out.push(`- ${entryName('compliance', c.id)}: ${c.status} (${c.detail})`);
  }
  const findings = profile.security?.findings ?? [];
  out.push('', '## Security', '');
  if (findings.length === 0) out.push('- no security signals found');
  for (const f of findings) out.push(`- [${f.severity}] ${f.id}: ${f.file}:${f.line} (${f.detail})`);
  for (const v of profile.security?.vulnerable ?? []) {
    out.push(`- [${v.severity}] ${v.id}: ${v.coord}:${v.version} at ${v.file}:${v.line} (${v.summary}; ${v.source})`);
  }
  for (const c of profile.security?.unresolvedChecks ?? []) out.push(`- not checked (version unresolved): ${c}`);
  return out.join('\n') + '\n';
}
