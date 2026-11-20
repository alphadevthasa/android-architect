// Static, best-effort parser for build.gradle / build.gradle.kts text.
// Line-oriented scanner with brace-depth tracking; not a Groovy/Kotlin grammar.
// Never throws: unparseable input just yields fewer results.

import { resolveAlias, resolveBundle } from './version-catalog.js';

const KEYWORDS = new Set(['val', 'var', 'def', 'if', 'else', 'for', 'while', 'return', 'exclude', 'because', 'println', 'import', 'package']);
// A bare reference such as deps.retrofit or rootProject.ext.deps.retrofit.
const IDENT_REF = /^[A-Za-z_][\w.]*(?:\[[^\]]*\])?\s*\)?\s*$/;
const NOTATION_START = /^(?:["']|libs\b|projects\b|platform\b|enforcedPlatform\b|testFixtures\b|project\b|kotlin\s*\(|group\b|name\b)/;

// For each char of s, true when it is inside (or delimits) a single-line string.
function stringMask(s) {
  const mask = new Array(s.length).fill(false);
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === null) {
      if (c === '"' || c === "'") { quote = c; mask[i] = true; }
    } else {
      mask[i] = true;
      if (c === '\\') { if (i + 1 < s.length) mask[++i] = true; }
      else if (c === quote) quote = null;
    }
  }
  return mask;
}

// Removes // and /* */ comments, keeping every newline so line numbers hold.
export function stripComments(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const two = s.substr(i, 2);
    const three = s.substr(i, 3);
    if (three === '"""' || three === "'''") {
      const end = s.indexOf(three, i + 3);
      const stop = end < 0 ? s.length : end + 3;
      out += s.slice(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, s.length);
      out += s.slice(i, s[j] === c ? stop : Math.min(j, s.length));
      i = s[j] === c ? stop : Math.min(j, s.length);
    } else if (two === '//') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (two === '/*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end < 0 ? s.length : end + 2;
      out += s.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function matchingBrace(s, open) {
  const mask = stringMask(s.slice(open));
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (mask[i - open]) continue;
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return s.length;
}

function mapEntries(body, prefix, out) {
  const re = /([A-Za-z_]\w*)\s*:\s*(?:"([^"]*)"|'([^']*)'|(\d+)\b(?!\s*[.\w]))/g;
  let m;
  while ((m = re.exec(body))) out[`${prefix}.${m[1]}`] = m[2] ?? m[3] ?? m[4];
}

// Integer literal assigned as a whole value (`= 33`, not `= 33.toString()`).
const NUM = String.raw`(\d+)(?![\w.])`;

function parseExtFromStripped(s) {
  const out = {};
  const lit = String.raw`(?:"([^"$]*)"|'([^']*)')`;
  // ext { k = "v"; m = [a: 'b'] }
  const blockRe = /\b(?:ext|extra)\s*\{/g;
  let b;
  while ((b = blockRe.exec(s))) {
    const open = b.index + b[0].length - 1;
    const body = s.slice(open + 1, matchingBrace(s, open));
    let m;
    const mapRe = /([A-Za-z_]\w*)\s*=\s*\[([^\]]*)\]/g;
    while ((m = mapRe.exec(body))) mapEntries(m[2], m[1], out);
    const strRe = new RegExp(String.raw`([A-Za-z_]\w*)\s*=\s*${lit}`, 'g');
    while ((m = strRe.exec(body))) out[m[1]] = m[2] ?? m[3];
    const numRe = new RegExp(String.raw`(?:^|[\s;{])([A-Za-z_]\w*)\s*=\s*${NUM}`, 'g');
    while ((m = numRe.exec(body))) out[m[1]] = m[2];
    const setRe = new RegExp(String.raw`\bset\s*\(\s*(?:"([^"]*)"|'([^']*)')\s*,\s*${lit}`, 'g');
    while ((m = setRe.exec(body))) out[m[1] ?? m[2]] = m[3] ?? m[4];
  }
  let m;
  // ext.k = 'v' / rootProject.ext.k = 'v'
  const dotRe = new RegExp(String.raw`\b(?:ext|extra)\.([A-Za-z_]\w*)\s*=\s*${lit}`, 'g');
  while ((m = dotRe.exec(s))) out[m[1]] = m[2] ?? m[3];
  // ext.k = 21
  const dotNumRe = new RegExp(String.raw`\b(?:ext|extra)\.([A-Za-z_]\w*)\s*=\s*${NUM}`, 'g');
  while ((m = dotNumRe.exec(s))) out[m[1]] = m[2];
  // ext.versions = [a: 'b']
  const dotMapRe = /\b(?:ext|extra)\.([A-Za-z_]\w*)\s*=\s*\[([^\]]*)\]/g;
  while ((m = dotMapRe.exec(s))) mapEntries(m[2], m[1], out);
  // extra["k"] = "v"
  const idxRe = new RegExp(String.raw`\b(?:ext|extra)\s*\[\s*(?:"([^"]*)"|'([^']*)')\s*\]\s*=\s*${lit}`, 'g');
  while ((m = idxRe.exec(s))) out[m[1] ?? m[2]] = m[3] ?? m[4];
  // extra.set("k", "v")
  const setRe2 = new RegExp(String.raw`\b(?:ext|extra)\.set\s*\(\s*(?:"([^"]*)"|'([^']*)')\s*,\s*${lit}`, 'g');
  while ((m = setRe2.exec(s))) out[m[1] ?? m[2]] = m[3] ?? m[4];
  // val k by extra("v")
  const byRe = new RegExp(String.raw`\bval\s+([A-Za-z_]\w*)\s+by\s+extra\s*\(\s*${lit}`, 'g');
  while ((m = byRe.exec(s))) out[m[1]] = m[2] ?? m[3];
  return out;
}

export function parseExtBlocks(text) {
  try { return parseExtFromStripped(stripComments(text)); } catch { return {}; }
}

function localVars(s) {
  const out = {};
  const re = /\b(?:val|var|def|String)\s+([A-Za-z_]\w*)\s*(?::\s*String\s*)?=\s*(?:"([^"$]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2] ?? m[3];
  return out;
}

function lookupVar(lookup, expr) {
  let k = expr.trim()
    .replace(/\[\s*["']([^"']*)["']\s*\]/g, '.$1');
  // Provider and conversion suffixes: .get(), .toInt(), .toInteger(), in any order.
  for (let n = k.replace(/\.(?:get|toInt|toInteger)\(\)$/, ''); n !== k; n = k.replace(/\.(?:get|toInt|toInteger)\(\)$/, '')) k = n;
  for (;;) {
    const n = k.replace(/^(?:rootProject|project|ext|extra|getRootProject\(\))\./, '');
    if (n === k) break;
    k = n;
  }
  return Object.hasOwn(lookup, k) ? lookup[k] : undefined;
}

// Substitutes $name / ${a.b} using lookup. Returns { value, resolved }.
function interpolate(str, lookup) {
  let resolved = true;
  const value = str.replace(/\$\{([^}]*)\}|\$([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*)/g, (all, a, b) => {
    const v = lookupVar(lookup, a ?? b);
    if (v === undefined) { resolved = false; return all; }
    return v;
  });
  return { value, resolved };
}

function finishVersion(raw, lookup) {
  if (raw == null || raw === '') return { version: null, unresolved: false };
  let v = String(raw);
  if (v.includes('$')) {
    const r = interpolate(v, lookup);
    if (!r.resolved) return { version: null, unresolved: true };
    v = r.value;
  }
  v = v.split('@')[0];
  return v ? { version: v, unresolved: false } : { version: null, unresolved: false };
}

function parseCoordinate(str, configuration, line, lookup) {
  const parts = str.split(':');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const { version, unresolved } = finishVersion(parts[2], lookup);
  const sub = (p) => (p.includes('$') ? interpolate(p, lookup).value : p);
  return { configuration, group: sub(parts[0]), name: sub(parts[1]), version, unresolved, line };
}

const STR = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')`;

function parseDependency(stmt, vc, lookup, line) {
  const m = /^([A-Za-z_]\w*)\s*(?:\(\s*|\s+)(.+)$/.exec(stmt);
  if (!m || KEYWORDS.has(m[1])) return [];
  const configuration = m[1];
  let rest = m[2].trim();
  if (!NOTATION_START.test(rest) && !IDENT_REF.test(rest)) return [];
  if (/^["']/.test(rest)) {
    // One statement may carry several coordinates: implementation 'a:b:1', 'c:d:2'
    const rows = [];
    const lit = new RegExp(`^${STR}\\s*,?\\s*`);
    let pos = rest;
    let mm;
    while ((mm = lit.exec(pos))) {
      const row = parseCoordinate(mm[1] ?? mm[2], configuration, line, lookup);
      if (row) rows.push(row);
      pos = pos.slice(mm[0].length);
    }
    return rows;
  }
  const row = parseNotation(rest, configuration, vc, lookup, line);
  return row ? [row] : [];
}

function parseNotation(rest, configuration, vc, lookup, line) {
  const w = /^(?:platform|enforcedPlatform|testFixtures)\s*\(\s*(.+)$/.exec(rest);
  if (w) return parseNotation(w[1].trim(), configuration, vc, lookup, line);

  const proj = new RegExp(String.raw`^project\s*\(\s*(?:path\s*[:=]\s*)?${STR}`).exec(rest);
  if (proj) return { configuration, group: null, name: null, version: null, unresolved: false, project: proj[1] ?? proj[2], line };

  const kt = /^kotlin\s*\(\s*(?:"([^"]*)"|'([^']*)')(?:\s*,\s*(?:"([^"]*)"|'([^']*)'))?/.exec(rest);
  if (kt) {
    const { version, unresolved } = finishVersion(kt[3] ?? kt[4], lookup);
    return { configuration, group: 'org.jetbrains.kotlin', name: `kotlin-${kt[1] ?? kt[2]}`, version, unresolved, line };
  }

  const lit = new RegExp(`^${STR}`).exec(rest);
  if (lit) return parseCoordinate(lit[1] ?? lit[2], configuration, line, lookup);

  const pa = /^projects((?:\.[A-Za-z_]\w*)+)/.exec(rest);
  if (pa) {
    const segs = pa[1].slice(1).split('.').map((x) => x.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase());
    return { configuration, group: null, name: null, version: null, unresolved: false, project: ':' + segs.join(':'), line };
  }

  const lib = /^((?:libs|projects)(?:\.[A-Za-z_][\w-]*)+)/.exec(rest);
  if (lib) {
    const accessor = lib[1].replace(/\.(?:get|asProvider)$/, '');
    const r = vc && accessor.startsWith('libs.') ? resolveAlias(vc, accessor) : null;
    if (r && r.kind === 'library') {
      const { version, unresolved } = finishVersion(r.version, lookup);
      return { configuration, group: r.group, name: r.name, version, unresolved, alias: r.alias, line };
    }
    const dep = { configuration, group: null, name: null, version: null, unresolved: true, alias: accessor.replace(/^libs\./, ''), line };
    const b = vc && accessor.startsWith('libs.bundles.') ? resolveBundle(vc, accessor) : null;
    // A known bundle keeps its unresolved row and carries its libraries, for checks that look at coordinates.
    if (b) {
      dep.bundle = {
        complete: b.complete,
        members: b.members.map((m) => ({ group: m.group, name: m.name, ...finishVersion(m.version, lookup), alias: m.alias })),
      };
    }
    return dep;
  }

  if (/^(?:group|name)\b/.test(rest)) {
    const field = (k) => {
      const mm = new RegExp(String.raw`\b${k}\s*[:=]\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Za-z_][\w.]*))`).exec(rest);
      return mm ? { v: mm[1] ?? mm[2], ident: mm[3] } : null;
    };
    const g = field('group'), n = field('name'), ver = field('version');
    if (!g?.v || !n?.v) return null;
    let raw = ver?.v;
    if (ver && ver.ident !== undefined) {
      const v = lookupVar(lookup, ver.ident);
      raw = v === undefined ? '$' + ver.ident : v;
    }
    const { version, unresolved } = finishVersion(raw, lookup);
    return { configuration, group: g.v, name: n.v, version, unresolved, line };
  }

  if (IDENT_REF.test(rest)) {
    const v = lookupVar(lookup, rest.replace(/\s*\)\s*$/, ''));
    const row = typeof v === 'string' ? parseCoordinate(v, configuration, line, lookup) : null;
    return row ?? { configuration, group: null, name: null, version: null, unresolved: true, line };
  }
  return null;
}

function parsePluginStmt(stmt, vc, line) {
  let m = new RegExp(String.raw`^id\s*\(?\s*${STR}\s*\)?(?:\s+version\s*\(?\s*${STR})?`).exec(stmt);
  if (m) return { id: m[1] ?? m[2], version: m[3] ?? m[4] ?? null, line };
  m = new RegExp(String.raw`^kotlin\s*\(\s*${STR}\s*\)(?:\s+version\s*\(?\s*${STR})?`).exec(stmt);
  if (m) return { id: `org.jetbrains.kotlin.${m[1] ?? m[2]}`, version: m[3] ?? m[4] ?? null, line };
  m = /^alias\s*\(\s*(libs(?:\.[A-Za-z_][\w-]*)+?)\s*\)/.exec(stmt);
  if (m && vc) {
    const r = resolveAlias(vc, m[1]);
    if (r && r.kind === 'plugin') return { id: r.id, version: r.version ?? null, line };
  }
  return null;
}

function parseSdk(raw, lookup) {
  const t = raw.trim();
  let m = /^["']?(?:android-)?(\d+)["']?\s*\)?$/.exec(t);
  if (m) return Number(m[1]);
  m = /^release\s*\(\s*(\d+)/.exec(t);
  if (m) return Number(m[1]);
  let v = lookupVar(lookup, t);
  if (v === undefined) v = lookupVar(lookup, t.replace(/[)\s]+$/, ''));
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
}

function parseAndroidStmt(stmt, top, android, lookup) {
  let m;
  if ((m = new RegExp(String.raw`^namespace\s*=?\s*\(?\s*${STR}`).exec(stmt))) {
    android.namespace ??= m[1] ?? m[2];
    return;
  }
  m = /^(minSdk|targetSdk|compileSdk)(?:Version)?\s*(?:=|\()?\s*(.+)$/.exec(stmt);
  if (m) {
    const n = parseSdk(m[2], lookup);
    if (n !== undefined) android[m[1]] ??= n;
    return;
  }
  if (top === 'compileSdk' || top === 'minSdk' || top === 'targetSdk') {
    m = /^version\s*=\s*(.+)$/.exec(stmt);
    const n = m && parseSdk(m[1], lookup);
    if (n !== undefined && n !== null) android[top] ??= n;
    return;
  }
  if (top === 'buildFeatures') {
    for (const mm of stmt.matchAll(/\b(compose|viewBinding|dataBinding)\s*(?:=\s*)?(true|false)\b/g)) {
      android.buildFeatures[mm[1]] = mm[2] === 'true';
    }
    return;
  }
  if (top === 'viewBinding' || top === 'dataBinding') {
    m = /^(?:isEnabled|enabled)\s*=?\s*(true|false)\b/.exec(stmt);
    if (m) android.buildFeatures[top] ??= m[1] === 'true';
  }
}

const MAX_JOIN = 20;

function parenDepth(text) {
  const mask = stringMask(text);
  let d = 0;
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) continue;
    if (text[i] === '(') d++;
    else if (text[i] === ')') d--;
  }
  return d;
}

function blockName(header) {
  const m = /([A-Za-z_][\w.]*)\s*(?:\(.*\))?\s*$/.exec(header.trim());
  if (!m) return '';
  const parts = m[1].split('.');
  return parts[parts.length - 1];
}

export function parseBuildFile(text, kind, ctx = {}) {
  const result = { plugins: [], dependencies: [], android: { buildFeatures: {} }, ext: {} };
  try {
    const stripped = stripComments(text);
    const own = parseExtFromStripped(stripped);
    result.ext = own;
    const vc = ctx?.versionCatalog ?? null;
    // libs.versions.<key> accessors; TOML `a-b` / `a_b` keys are `a.b` accessors.
    const catalogVersions = {};
    for (const [key, value] of Object.entries(vc?.versions ?? {})) {
      catalogVersions[`libs.versions.${key}`] = value;
      catalogVersions[`libs.versions.${key.replace(/[-_]/g, '.')}`] = value;
    }
    const lookup = { ...catalogVersions, ...(ctx?.ext ?? {}), ...localVars(stripped), ...own };
    const android = result.android;
    const stack = [];

    const rawLines = stripped.split('\n');
    for (let idx = 0; idx < rawLines.length; idx++) {
      const line = idx + 1;
      let lineText = rawLines[idx];
      // Join continuation lines while parentheses are unbalanced (capped, so
      // garbage cannot swallow the file); the statement keeps its first line.
      if (parenDepth(lineText) > 0) {
        let joined = lineText;
        let end = idx;
        while (end + 1 < rawLines.length && end - idx < MAX_JOIN && parenDepth(joined) > 0) {
          joined += ' ' + rawLines[++end].trim();
        }
        if (parenDepth(joined) <= 0) { lineText = joined; idx = end; }
      }
      const mask = stringMask(lineText);
      let segStart = 0;
      const handle = (seg) => {
        // Statements are separated by ';' outside strings.
        const segMask = mask.slice(segStart, segStart + seg.length);
        const stmts = [];
        let cur = 0;
        for (let i = 0; i < seg.length; i++) {
          if (seg[i] === ';' && !segMask[i]) { stmts.push(seg.slice(cur, i)); cur = i + 1; }
        }
        stmts.push(seg.slice(cur));
        const top = stack[stack.length - 1];
        const inAndroid = stack.includes('android');
        for (const raw of stmts) {
          const stmt = raw.trim();
          if (!stmt) continue;
          const legacy = /\bapply\s*\(?\s*plugin\s*[:=]\s*(?:"([^"]*)"|'([^']*)')/.exec(stmt);
          if (legacy) result.plugins.push({ id: legacy[1] ?? legacy[2], version: null, line });
          if (top === 'plugins') {
            const p = parsePluginStmt(stmt, vc, line);
            if (p) result.plugins.push(p);
          } else if (top === 'dependencies') {
            result.dependencies.push(...parseDependency(stmt, vc, lookup, line));
          } else if (inAndroid) {
            parseAndroidStmt(stmt, top, android, lookup);
          }
        }
      };
      for (let i = 0; i <= lineText.length; i++) {
        const c = lineText[i];
        if (i === lineText.length || (!mask[i] && (c === '{' || c === '}'))) {
          const seg = lineText.slice(segStart, i);
          handle(seg);
          if (c === '{') stack.push(blockName(seg));
          else if (c === '}') stack.pop();
          segStart = i + 1;
        }
      }
    }
  } catch {
    // best effort: return whatever was collected
  }
  return result;
}
