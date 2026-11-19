const STOPWORDS = new Set('the a an and or of to in for is on with this that it be as by'.split(' '));
const MIN_LEN = 2;
const MAX_LEN = 40;

/** Lowercase tokens: whole identifiers plus their camelCase and digit-boundary parts. */
export function tokenize(text) {
  const out = [];
  for (const word of String(text).split(/[^A-Za-z0-9]+/)) {
    if (!word) continue;
    const spaced = word
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2');
    const parts = new Set([word.toLowerCase(), ...spaced.toLowerCase().split(' ')]);
    for (const t of parts) {
      if (t.length >= MIN_LEN && t.length <= MAX_LEN && !STOPWORDS.has(t)) out.push(t);
    }
  }
  return out;
}
