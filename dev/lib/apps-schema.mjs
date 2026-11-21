// Validator for test/eval/apps.json, shared by the eval suite and dev/fetch-eval-apps.mjs.
// Pure and linear-time: fixed patterns only, nothing is built from manifest text. Returns a list of error strings.
export const ERAS = ['legacy-java-mvp', 'mvvm-rxjava', 'modern-compose'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const APP_KEYS = new Set(['id', 'era', 'repo', 'commit', 'license', 'notes']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The URL must already be in WHATWG-normalized form (repo === new URL(repo).href), so the string git receives is the
// string that was validated. No userinfo, default port only, a dotted DNS name (no IP literal, no localhost).
function repoError(repo) {
  if (typeof repo !== 'string' || repo === '') return 'repo must be a non-empty string';
  for (let i = 0; i < repo.length; i++) {
    const c = repo.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return 'repo must not contain whitespace or control characters';
  }
  let u;
  try {
    u = new URL(repo);
  } catch {
    return 'repo must be a valid URL';
  }
  if (u.protocol !== 'https:') return 'repo must be an https:// URL';
  if (u.href !== repo) return 'repo must be written in normalized form (https://host/path, no dot segments)';
  if (u.username !== '' || u.password !== '') return 'repo must not embed credentials';
  if (u.port !== '') return 'repo must use the default https port';
  if (u.search !== '' || u.hash !== '') return 'repo must not have a query or fragment';
  const h = u.hostname;
  if (h === '' || h.startsWith('[') || /^[0-9.]+$/.test(h)) return 'repo host must be a DNS name, not an IP literal';
  if (h === 'localhost' || h.endsWith('.localhost') || !h.includes('.')) return 'repo host must be a public dotted DNS name';
  return null;
}

export function validateApps(manifest) {
  const errors = [];
  if (!isObj(manifest)) return ['apps.json must be an object'];
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(manifest.apps)) return [...errors, 'apps must be an array'];
  const seen = new Set();
  manifest.apps.forEach((app, i) => {
    const w = `apps[${i}]`;
    if (!isObj(app)) {
      errors.push(`${w} must be an object`);
      return;
    }
    for (const k of Object.keys(app)) if (!APP_KEYS.has(k)) errors.push(`${w}: unknown key "${k.slice(0, 40)}"`);
    if (typeof app.id !== 'string' || !ID_RE.test(app.id)) errors.push(`${w}: id must match ${ID_RE}`);
    else if (seen.has(app.id)) errors.push(`${w}: duplicate id`);
    else seen.add(app.id);
    if (!ERAS.includes(app.era)) errors.push(`${w}: era must be one of ${ERAS.join(', ')}`);
    const re = repoError(app.repo);
    if (re) errors.push(`${w}: ${re}`);
    if (typeof app.commit !== 'string' || !COMMIT_RE.test(app.commit)) errors.push(`${w}: commit must be 40 lowercase hex characters`);
    if (typeof app.license !== 'string' || app.license.trim() === '') errors.push(`${w}: license must be a non-empty string`);
    if (app.notes !== undefined && typeof app.notes !== 'string') errors.push(`${w}: notes must be a string`);
  });
  return errors;
}
