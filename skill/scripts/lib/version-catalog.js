// Minimal parser for the TOML subset used by gradle/libs.versions.toml.
// Supports [section] headers and `key = value` lines where value is a string
// or a single-line inline table. Anything else is skipped, never thrown on.

const norm = (k) => String(k).replace(/[-_.]/g, '-');

// For each char of s, true when it is inside (or delimits) a quoted string.
// Basic strings use "..." with backslash escapes; literal strings use '...'
// with no escapes. The other quote kind inside a string is literal.
function stringMask(s) {
  const mask = new Array(s.length).fill(false);
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === null) {
      if (c === '"' || c === "'") { quote = c; mask[i] = true; }
    } else {
      mask[i] = true;
      if (quote === '"' && c === '\\') { if (i + 1 < s.length) mask[++i] = true; }
      else if (c === quote) quote = null;
    }
  }
  return mask;
}

function stripComment(line) {
  const q = stringMask(line);
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '#' && !q[i]) return line.slice(0, i);
  }
  return line;
}

// Net bracket depth change of a line, ignoring brackets inside quoted strings.
function depthDelta(line) {
  const q = stringMask(line);
  let d = 0;
  for (let i = 0; i < line.length; i++) {
    if (q[i]) continue;
    const c = line[i];
    if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return d;
}

function splitTop(s, sep) {
  const q = stringMask(s);
  const parts = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!q[i]) {
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function parseString(v) {
  const m = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/.exec(v.trim());
  return m ? (m[1] ?? m[2]) : null;
}

// Returns a string, a plain object (inline table), or undefined.
function parseValue(raw) {
  const v = raw.trim();
  const s = parseString(v);
  if (s !== null) return s;
  if (v.startsWith('{') && v.endsWith('}')) {
    const obj = {};
    for (const part of splitTop(v.slice(1, -1), ',')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const key = part.slice(0, i).trim();
      const val = parseValue(part.slice(i + 1));
      if (key && val !== undefined) obj[key] = val;
    }
    return obj;
  }
  return undefined;
}

function versionOf(entry, versions) {
  let v = entry.version;
  if (v === undefined && entry['version.ref'] !== undefined) v = { ref: entry['version.ref'] };
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    if (typeof v.ref === 'string') return (Object.hasOwn(versions, v.ref) ? versions[v.ref] : null);
    for (const k of ['strictly', 'prefer', 'require']) {
      if (typeof v[k] === 'string') return v[k];
    }
  }
  return null;
}

export function parseVersionCatalog(text) {
  const vc = { versions: {}, libraries: {}, plugins: {} };
  const raw = { libraries: [], plugins: [] };
  let section = null;
  let skipDepth = 0; // inside a multi-line value we do not understand

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    if (skipDepth > 0) {
      skipDepth += depthDelta(line);
      if (skipDepth < 0) skipDepth = 0;
      continue;
    }
    const h = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (h) { section = h[1]; continue; }
    const i = line.indexOf('=');
    if (i < 0 || !section) continue;
    const key = line.slice(0, i).trim().replace(/^["']|["']$/g, '');
    const valText = line.slice(i + 1).trim();
    if (!key) continue;
    const open = depthDelta(valText);
    if (open > 0) { skipDepth = open; continue; }
    const val = parseValue(valText);
    if (val === undefined) continue;
    if (section === 'versions') {
      if (typeof val === 'string') vc.versions[key] = val;
      else if (val && typeof val === 'object') {
        const v = versionOf({ version: val }, {});
        if (v !== null) vc.versions[key] = v;
      }
    } else if (section === 'libraries' || section === 'plugins') {
      raw[section].push([key, val]);
    }
  }

  for (const [key, val] of raw.libraries) {
    let group, name, version = null;
    if (typeof val === 'string') {
      [group, name, version = null] = val.split(':');
    } else {
      if (typeof val.module === 'string') [group, name] = val.module.split(':');
      else { group = val.group; name = val.name; }
      version = versionOf(val, vc.versions);
    }
    if (typeof group === 'string' && typeof name === 'string') {
      vc.libraries[norm(key)] = { group, name, version };
    }
  }
  for (const [key, val] of raw.plugins) {
    if (typeof val === 'string') {
      const [id, version = null] = val.split(':');
      vc.plugins[norm(key)] = { id, version };
    } else if (typeof val.id === 'string') {
      vc.plugins[norm(key)] = { id: val.id, version: versionOf(val, vc.versions) };
    }
  }
  return vc;
}

export function resolveAlias(vc, accessor) {
  const parts = String(accessor ?? '').split('.');
  if (parts[0] !== 'libs' || parts.length < 2) return null;
  if (parts[1] === 'versions' || parts[1] === 'bundles') return null;
  if (parts[1] === 'plugins') {
    const alias = norm(parts.slice(2).join('.'));
    const p = Object.hasOwn(vc.plugins, alias) ? vc.plugins[alias] : null;
    return p ? { kind: 'plugin', id: p.id, version: p.version, alias } : null;
  }
  const alias = norm(parts.slice(1).join('.'));
  const l = Object.hasOwn(vc.libraries, alias) ? vc.libraries[alias] : null;
  return l ? { kind: 'library', group: l.group, name: l.name, version: l.version, alias } : null;
}
