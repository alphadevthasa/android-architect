function sortedCounts(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** Build a BM25 model (term counts only) from `{id, tokens}` documents. */
export function buildBm25(docs) {
  const df = new Map();
  let total = 0;
  const out = docs.map((d) => {
    const tf = sortedCounts(d.tokens);
    for (const t of Object.keys(tf)) df.set(t, (df.get(t) ?? 0) + 1);
    total += d.tokens.length;
    return { id: d.id, len: d.tokens.length, tf };
  });
  const sortedDf = Object.fromEntries([...df].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  return { avgdl: docs.length ? total / docs.length : 0, df: sortedDf, docs: out };
}

/** Score documents for the query tokens; best first, ties by id, score > 0 only. */
export function scoreBm25(model, queryTokens, { k1 = 1.2, b = 0.75 } = {}) {
  const n = model.docs.length;
  const terms = [...new Set(queryTokens)].filter((t) => Object.hasOwn(model.df, t));
  const results = [];
  for (const doc of model.docs) {
    let score = 0;
    for (const t of terms) {
      if (!Object.hasOwn(doc.tf, t)) continue;
      const f = doc.tf[t];
      const idf = Math.log(1 + (n - model.df[t] + 0.5) / (model.df[t] + 0.5));
      const norm = model.avgdl > 0 ? 1 - b + (b * doc.len) / model.avgdl : 1;
      score += (idf * f * (k1 + 1)) / (f + k1 * norm);
    }
    if (score > 0) results.push({ id: doc.id, score });
  }
  return results.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}
