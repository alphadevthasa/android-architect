/**
 * Compare dotted versions numerically, ignoring qualifiers (`2.0.21-1.0.28` -> 2.0.21).
 * A qualifier never lowers a version: `2.8.9-rc1` compares equal to `2.8.9`.
 */
export function compareVersions(a, b) {
  const parse = (v) => String(v).split(/[-+]/)[0].split('.').map((s) => parseInt(s, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
