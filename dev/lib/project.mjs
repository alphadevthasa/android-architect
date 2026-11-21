// Projections of scan/candidates output that goldens record and the eval asserts. Shared with dev/record-eval.mjs
// so the recorded shape and the asserted shape cannot drift. Volatile fields (root, evidence, timestamps) are left out.
export function projectProfile(p) {
  const dimensions = {};
  for (const [dim, v] of Object.entries(p.dimensions)) {
    if (v.entries.length > 0) dimensions[dim] = v.entries.map((e) => [e.id, e.share]);
  }
  return {
    catalogVersion: p.catalogVersion,
    sdk: p.sdk,
    size: p.size,
    modules: p.modules.map((m) => ({ path: m.path, projectDeps: m.projectDeps })),
    dimensions,
  };
}

export function projectCandidates(c) {
  const out = {};
  for (const [dim, v] of Object.entries(c)) {
    if (v.current.length > 0) out[dim] = { current: v.current, next: v.next, reachable: v.reachable, blocked: Object.keys(v.blockedBy) };
  }
  return out;
}
