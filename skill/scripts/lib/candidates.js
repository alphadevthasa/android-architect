// Computes catalog-legal migration targets for each dimension of a StackProfile.

// An entry is present when it has detected units, a positive share, or
// share === null (a computed presence flag). A share that rounds to 0 with
// units > 0 is a small minority, not absence.
export function presentEntries(profile, dimId) {
  const entries = profile?.dimensions?.[dimId]?.entries ?? [];
  return entries.filter((e) => e.share === null || e.share > 0 || e.units > 0);
}

export function presentIds(profile, dimId) {
  return new Set(presentEntries(profile, dimId).map((e) => e.id));
}

export function prerequisiteMet(profile, prereq) {
  const present = presentIds(profile, prereq.dimension);
  return prereq.anyOf.some((id) => present.has(id));
}

export function candidatePaths(profile, catalog) {
  const out = {};
  for (const dim of catalog.dimensions) {
    const present = presentEntries(profile, dim.id);
    const current = [...present]
      .sort((a, b) => {
        if ((a.share === null) !== (b.share === null)) return a.share === null ? 1 : -1;
        if (a.share !== null && a.share !== b.share) return b.share - a.share;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map((e) => e.id);
    const currentSet = new Set(current);
    const next = new Set();
    for (const id of current) {
      for (const s of catalog.entry(dim.id, id)?.successors ?? []) next.add(s);
    }
    const reachable = new Set();
    const queue = [...current];
    while (queue.length) {
      const id = queue.shift();
      for (const s of catalog.entry(dim.id, id)?.successors ?? []) {
        if (!reachable.has(s)) {
          reachable.add(s);
          queue.push(s);
        }
      }
    }
    const blockedBy = {};
    for (const id of reachable) {
      if (currentSet.has(id)) continue;
      const unmet = (catalog.entry(dim.id, id)?.prerequisites ?? []).filter((p) => !prerequisiteMet(profile, p));
      if (unmet.length) blockedBy[id] = unmet.map((p) => ({ dimension: p.dimension, anyOf: p.anyOf }));
    }
    out[dim.id] = {
      current,
      next: [...next].filter((id) => !currentSet.has(id)),
      reachable: [...reachable].filter((id) => !currentSet.has(id)),
      blockedBy,
    };
  }
  return out;
}
