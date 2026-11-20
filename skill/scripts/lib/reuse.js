import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listFiles } from './walk.js';
import { discoverModules } from './modules.js';
import { renderComponents } from './knowledge.js';

export { renderComponents };

const MAX_READ_BYTES = 1024 * 1024; // larger files are reported ("too large to scan") and skipped, never read
const MAX_BODY = 20000; // longest function / block body examined, in characters
const MAX_PARAMS = 2000;
const MAX_ATTEMPTS = 2000; // declarations tried per file, successful or not
const MAX_ITEMS = 500; // functions, try blocks and builders examined per file: keeps every pass linear and bounded
const MIN_LAYOUT_ELEMENTS = 4;
const MIN_COMPOSABLE_CALLS = 3;
const MIN_UTIL_LINES = 4;
const MIN_BOILERPLATE = 3;
const SHARED_NAMES = new Set(['designsystem', 'design-system', 'ui', 'common', 'core-ui', 'shared']);
const TOKEN_FILE = /^(colors?|theme|dimens?|spacing|tokens?|palette)\.kt$/i;
const NOT_COMPONENT_CALLS = new Set(['Color', 'TextStyle', 'Offset', 'Size', 'RoundedCornerShape', 'PaddingValues']);
const DECLARATION = /(^|[^A-Za-z0-9_$])(class|object|interface|fun)(?![A-Za-z0-9_$])/;
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'else', 'return', 'new', 'try', 'do']);

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const isIdent = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
const isHex = (c) => c !== undefined && /[0-9A-Fa-f]/.test(c);
const isDigit = (c) => c !== undefined && c >= '0' && c <= '9';
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const extOf = (rel) => path.posix.extname(rel).toLowerCase();

/** Source set of a path (src/<set>/...), or null. */
function sourceSet(rel) {
  const s = rel.split('/');
  const i = s.indexOf('src');
  return i >= 0 && i + 1 < s.length - 1 ? s[i + 1] : null;
}
const isTestSet = (set) => set !== null && (set.startsWith('test') || set.startsWith('androidTest'));

/** Layout files (res/layout and its qualifier directories). Returns the key with the qualifier removed, or null. */
function layoutKey(rel) {
  const s = rel.split('/');
  if (extOf(rel) !== '.xml' || s.length < 3) return null;
  const dir = s[s.length - 2];
  if (s[s.length - 3] !== 'res' || !dir.startsWith('layout')) return null;
  return [...s.slice(0, -2), s[s.length - 1]].join('/');
}
const isValuesXml = (rel) => {
  const s = rel.split('/');
  return extOf(rel) === '.xml' && s.length >= 3 && s[s.length - 3] === 'res' && s[s.length - 2].startsWith('values');
};

function fromCodes(codes) {
  const parts = [];
  for (let i = 0; i < codes.length; i += 8192) parts.push(String.fromCharCode(...codes.subarray(i, i + 8192)));
  return parts.join('');
}

/**
 * One linear pass over Kotlin/Java text. Returns { code, skel }, both the same length and line structure as the input:
 * comments become spaces in both; in `skel` string and char literal contents are blanked too, so braces and parens inside
 * strings never confuse the matchers.
 */
function mask(text) {
  const n = text.length;
  const code = new Uint16Array(n);
  const skel = new Uint16Array(n);
  let i = 0;
  const put = (k, c, s) => {
    code[k] = c;
    skel[k] = s;
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    const d = text.charCodeAt(i + 1);
    if (c === 47 && d === 47) { // line comment
      while (i < n && text.charCodeAt(i) !== 10) put(i++, 32, 32);
    } else if (c === 47 && d === 42) { // block comment
      put(i++, 32, 32);
      put(i++, 32, 32);
      while (i < n && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47)) {
        const k = text.charCodeAt(i);
        const v = k === 10 || k === 13 ? k : 32;
        put(i++, v, v);
      }
      if (i < n) {
        put(i++, 32, 32);
        put(i++, 32, 32);
      }
    } else if (c === 34 && d === 34 && text.charCodeAt(i + 2) === 34) { // raw string
      for (let k = 0; k < 3; k++) put(i + k, 34, 34);
      i += 3;
      while (i < n && !(text.charCodeAt(i) === 34 && text.charCodeAt(i + 1) === 34 && text.charCodeAt(i + 2) === 34)) {
        const k = text.charCodeAt(i);
        put(i++, k, k === 10 || k === 13 ? k : 32);
      }
      for (let k = 0; k < 3 && i < n; k++) put(i++, 34, 34);
    } else if (c === 34 || c === 39) { // string or char literal
      put(i++, c, c);
      while (i < n && text.charCodeAt(i) !== c && text.charCodeAt(i) !== 10) {
        const k = text.charCodeAt(i);
        if (k === 92 && i + 1 < n && text.charCodeAt(i + 1) !== 10) {
          put(i, k, 32);
          put(i + 1, text.charCodeAt(i + 1), 32);
          i += 2;
        } else {
          put(i++, k, 32);
        }
      }
      if (i < n && text.charCodeAt(i) === c) put(i++, c, c);
    } else {
      put(i++, c, c);
    }
  }
  return { code: fromCodes(code), skel: fromCodes(skel) };
}

/** Index of the bracket closing the one at `open`, searching at most `limit` characters; -1 when absent. */
function matchClose(s, open, o, c, limit) {
  let depth = 0;
  const end = Math.min(s.length, open + limit);
  for (let i = open; i < end; i++) {
    const ch = s[i];
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Start of the line holding idx, looking back at most 300 characters (a longer line is treated as starting there). */
function lineStartNear(s, idx) {
  const floor = Math.max(0, idx - 300);
  for (let i = idx; i > floor; i--) if (s[i - 1] === '\n') return i;
  return floor;
}

/** Index of `ch` in s[from, from + limit), or -1. */
function findWithin(s, ch, from, limit) {
  const end = Math.min(s.length, from + limit);
  for (let i = from; i < end; i++) if (s[i] === ch) return i;
  return -1;
}

const skipSpace = (s, i) => {
  while (i < s.length && isSpace(s[i])) i++;
  return i;
};

/** Offsets of `word` as a whole word in s. */
function* wordAt(s, word) {
  for (let i = s.indexOf(word); i !== -1; i = s.indexOf(word, i + 1)) {
    if (!isIdent(s[i - 1]) && !isIdent(s[i + word.length])) yield i;
  }
}

/** Parameter types of a Kotlin parameter list (text between the parentheses). */
function paramTypes(params) {
  const out = [];
  let depth = 0;
  let start = 0;
  const flush = (end) => {
    const part = params.slice(start, end);
    const colon = part.indexOf(':');
    if (colon !== -1) {
      let d = 0;
      let stop = part.length;
      for (let i = colon + 1; i < part.length; i++) {
        const ch = part[i];
        if (ch === '(' || ch === '<' || ch === '[' || ch === '{') d++;
        else if (ch === ')' || ch === ']' || ch === '}' || (ch === '>' && part[i - 1] !== '-')) d--;
        else if (ch === '=' && d === 0) {
          stop = i;
          break;
        }
      }
      out.push(collapse(part.slice(colon + 1, stop)));
    }
  };
  for (let i = 0; i < params.length; i++) {
    const ch = params[i];
    if (ch === '(' || ch === '<' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || (ch === '>' && params[i - 1] !== '-')) depth--;
    else if (ch === ',' && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  if (params.slice(start).trim() !== '') flush(params.length);
  return out;
}

/** Called composable-looking names in a body, in order: an upper-case identifier followed by `(` or `{`. */
function calledNames(body) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c >= 'A' && c <= 'Z' && !isIdent(body[i - 1]) && body[i - 1] !== '.') {
      let j = i + 1;
      while (isIdent(body[j])) j++;
      const name = body.slice(i, j);
      let k = j;
      while (body[k] === ' ' || body[k] === '\t') k++;
      if ((body[k] === '(' || body[k] === '{') && !NOT_COMPONENT_CALLS.has(name)) out.push(name);
      i = j - 1;
    }
  }
  return out;
}

/** Kotlin and Java functions with a block body: [{ name, line, params, bodyCode, composable, preview, override }]. */
function findFunctions(code, skel, lineOf, java) {
  const out = [];
  const add = (nameStart, nameEnd, parenIdx, funIdx) => {
    const close = matchClose(skel, parenIdx, '(', ')', MAX_PARAMS);
    if (close === -1) return;
    let i = close + 1;
    while (skel[i] === ' ' || skel[i] === '\t') i++;
    if (skel[i] === ':' && !java) {
      while (i < skel.length && i < close + 400 && skel[i] !== '{' && skel[i] !== '=' && skel[i] !== '\n') i++;
    } else if (java && skel.startsWith('throws', i)) {
      while (i < skel.length && i < close + 400 && skel[i] !== '{' && skel[i] !== ';') i++;
    }
    if (skel[i] !== '{') return;
    const end = matchClose(skel, i, '{', '}', MAX_BODY);
    if (end === -1) return;
    const lead = skel.slice(Math.max(0, funIdx - 200), funIdx);
    const cut = Math.max(lead.lastIndexOf('}'), lead.lastIndexOf(';'));
    // The annotation window starts after the last declaration line, so `class H(val c: @Composable () -> Unit)` cannot leak.
    const rest = lead.slice(cut + 1).split('\n');
    const current = rest.pop();
    let from = 0;
    for (let k = rest.length - 1; k >= 0; k--) {
      if (DECLARATION.test(rest[k])) {
        from = k + 1;
        break;
      }
    }
    const window = rest.slice(from).join('\n') + '\n' + current;
    const lineStart = lineStartNear(skel, funIdx);
    out.push({
      name: skel.slice(nameStart, nameEnd),
      line: lineOf(funIdx),
      params: skel.slice(parenIdx + 1, close),
      bodyCode: code.slice(i + 1, end),
      bodySkel: skel.slice(i + 1, end),
      composable: window.includes('@Composable'),
      preview: window.includes('@Preview'),
      override: window.includes('override') || skel.slice(lineStart, funIdx).includes('override') || window.includes('@Override'),
    });
  };
  if (!java) {
    let attempts = 0;
    for (const f of wordAt(skel, 'fun')) {
      if (out.length >= MAX_ITEMS || attempts++ >= MAX_ATTEMPTS) break;
      let i = skipSpace(skel, f + 3);
      if (skel[i] === '<') {
        const g = matchClose(skel, i, '<', '>', 300);
        if (g === -1) continue;
        i = skipSpace(skel, g + 1);
      }
      const paren = findWithin(skel, '(', i, 200);
      if (paren === -1) continue;
      const head = skel.slice(i, paren);
      if (head.includes('\n') || head.includes('{') || head.includes('=')) continue;
      const dot = head.lastIndexOf('.');
      const nameStart = i + (dot === -1 ? 0 : dot + 1);
      const nameEnd = i + head.trimEnd().length;
      if (nameEnd <= nameStart) continue;
      add(nameStart, nameEnd, paren, f);
    }
  } else {
    // Java: a line `<modifiers/type> name(...) {` whose text before the name has at least a type.
    let attempts = 0;
    for (let p = skel.indexOf('('); p !== -1 && out.length < MAX_ITEMS && attempts < MAX_ATTEMPTS; p = skel.indexOf('(', p + 1)) {
      let e = p;
      while (e > 0 && skel[e - 1] === ' ') e--;
      let s = e;
      while (isIdent(skel[s - 1])) s--;
      if (s === e || NOT_METHODS.has(skel.slice(s, e))) continue;
      attempts++;
      const lineStart = lineStartNear(skel, s);
      const before = skel.slice(lineStart, s).trim();
      if (before === '' || before.includes('=') || /^(return|new|else|throw)\b/.test(before)) continue;
      add(s, e, p, lineStart);
    }
  }
  return out;
}

/** Layout structure in one pass: element signature, element count, hardcoded colors and dp values in attribute values. */
function parseLayout(text) {
  const n = text.length;
  const sig = [];
  let elements = 0; // <include> and <merge> are not counted: they add no structure of their own
  let depth = 0;
  let colors = 0;
  let dp = 0;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (text[lt + 1] === '?' || text[lt + 1] === '!' || text[lt + 1] === '/') {
      if (text[lt + 1] === '/') depth = Math.max(0, depth - 1);
      const e = text.indexOf('>', lt + 1);
      i = e === -1 ? n : e + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && !isSpace(text[j]) && text[j] !== '>' && text[j] !== '/') j++;
    const element = [String(depth), text.slice(lt + 1, j)];
    const tag = element[1];
    for (;;) {
      while (j < n && isSpace(text[j])) j++;
      if (j >= n || text[j] === '>' || text[j] === '/') break;
      const s = j;
      while (j < n && !isSpace(text[j]) && text[j] !== '=' && text[j] !== '>' && text[j] !== '/') j++;
      const name = text.slice(s, j);
      while (j < n && isSpace(text[j])) j++;
      if (text[j] === '=') {
        j++;
        while (j < n && isSpace(text[j])) j++;
        const q = text[j];
        if (q === '"' || q === "'") {
          const e = text.indexOf(q, j + 1);
          const value = e === -1 ? text.slice(j + 1) : text.slice(j + 1, e);
          j = e === -1 ? n : e + 1;
          if (value[0] === '#' && (value.length === 7 || value.length === 9) && [...value.slice(1)].every(isHex)) colors++;
          else if (value[0] === '#' && (value.length === 4 || value.length === 5) && [...value.slice(1)].every(isHex)) colors++;
          else if (value.endsWith('dp') && value !== '0dp' && value.length > 2 && [...value.slice(0, -2)].every((c) => isDigit(c) || c === '.')) dp++;
        }
      }
      if (name !== 'android:id' && !name.startsWith('xmlns') && !name.startsWith('tools:') && name !== '') element.push(name);
    }
    sig.push(element.join(' '));
    if (tag !== 'include' && tag !== 'merge') elements++;
    const selfClosing = text[j] === '/';
    while (j < n && text[j] !== '>') j++;
    if (!selfClosing) depth++;
    i = j + 1;
  }
  return { sig, elements, colors, dp };
}

/** Count `Color(0x`, `#RRGGBB` / `#AARRGGBB` and `<digits>.dp` in masked Kotlin code. */
function composeTokens(code) {
  let colors = 0;
  let dp = 0;
  for (let i = code.indexOf('Color(0x'); i !== -1; i = code.indexOf('Color(0x', i + 1)) if (!isIdent(code[i - 1])) colors++;
  for (let i = code.indexOf('Color(0X'); i !== -1; i = code.indexOf('Color(0X', i + 1)) if (!isIdent(code[i - 1])) colors++;
  for (let i = code.indexOf('#'); i !== -1; i = code.indexOf('#', i + 1)) {
    let j = i + 1;
    while (isHex(code[j])) j++;
    if ([3, 4, 6, 8].includes(j - i - 1) && !isIdent(code[j])) colors++;
  }
  for (let i = code.indexOf('.dp'); i !== -1; i = code.indexOf('.dp', i + 1)) {
    if (isDigit(code[i - 1]) && !isIdent(code[i + 3])) dp++;
  }
  return { colors, dp };
}

function countOccurrences(text, needle) {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** try { } catch (...) { } blocks and OkHttp/Retrofit builder chains: [{ kind, line, text, lines }]. */
function findBoilerplate(code, skel, lineOf) {
  const out = [];
  let budget = MAX_ITEMS;
  for (const t of wordAt(skel, 'try')) {
    if (budget-- <= 0) break;
    let i = skipSpace(skel, t + 3);
    if (skel[i] !== '{') continue;
    const tryEnd = matchClose(skel, i, '{', '}', MAX_BODY);
    if (tryEnd === -1) continue;
    i = skipSpace(skel, tryEnd + 1);
    if (!skel.startsWith('catch', i)) continue;
    i = skipSpace(skel, i + 5);
    if (skel[i] !== '(') continue;
    const paren = matchClose(skel, i, '(', ')', MAX_PARAMS);
    if (paren === -1) continue;
    i = skipSpace(skel, paren + 1);
    if (skel[i] !== '{') continue;
    const end = matchClose(skel, i, '{', '}', MAX_BODY);
    if (end === -1) continue;
    const block = code.slice(t, end + 1);
    const lines = block.split('\n').filter((l) => l.trim() !== '').length;
    if (lines >= 3) out.push({ kind: 'error-handling', line: lineOf(t), text: collapse(block), lines });
  }
  for (const [needle, kind] of [['OkHttpClient.Builder()', 'okhttp-builder'], ['Retrofit.Builder()', 'retrofit-builder']]) {
    budget = MAX_ITEMS;
    for (let i = skel.indexOf(needle); i !== -1 && budget-- > 0; i = skel.indexOf(needle, i + needle.length)) {
      const b = i + skel.slice(i, i + MAX_BODY).indexOf('.build()');
      if (b < i) continue;
      const block = code.slice(i, b + 8);
      out.push({ kind, line: lineOf(i), text: collapse(block), lines: block.split('\n').filter((l) => l.trim() !== '').length });
    }
  }
  return out;
}

/** `class BaseXxx` declarations: [{ name, line, role }] with role activity|fragment|viewmodel (or null). */
function findBaseClasses(skel, lineOf) {
  const out = [];
  let offset = 0;
  for (const line of skel.split('\n')) {
    const head = line.slice(0, 400);
    for (let i = head.indexOf('class '); i !== -1; i = head.indexOf('class ', i + 1)) {
      if (isIdent(head[i - 1])) continue;
      let s = i + 6;
      while (head[s] === ' ') s++;
      let e = s;
      while (isIdent(head[e])) e++;
      const name = head.slice(s, e);
      if (!name.startsWith('Base') || name.length <= 4 || !(name[4] >= 'A' && name[4] <= 'Z')) continue;
      const hay = `${name} ${head.slice(e)}`;
      const role = name.includes('ViewModel') ? 'viewmodel' : name.includes('Fragment') ? 'fragment' : name.includes('Activity') ? 'activity'
        : hay.includes('ViewModel') ? 'viewmodel' : hay.includes('Fragment') ? 'fragment' : hay.includes('Activity') ? 'activity' : null;
      out.push({ name, line: lineOf(offset + i), role });
    }
    offset += line.length + 1;
  }
  return out;
}

function groupBy(items, keyOf) {
  const m = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

const sortedFiles = (files) => files.sort((a, b) => byText(a.file, b.file) || a.line - b.line);
const sortGroups = (groups) => groups.sort((a, b) => byText(a.files[0].file, b.files[0].file) || a.files[0].line - b.files[0].line || byText(a.kind ?? '', b.kind ?? ''));
const modulePathName = (p) => String(p).replace(/[^A-Za-z0-9_.:-]/g, '-');

/**
 * Detect duplicated and competing building blocks. Reads only git-visible project files (listFiles skips secret files);
 * files over 1 MB are not read: they are counted in `tooLarge` and left out of every check. Every pass is linear and capped.
 *
 * Returns { duplicates, baseClasses, boilerplate, tokens, sharedModules, duplicationScore, tooLarge }. `profile` is accepted
 * for symmetry with the other detectors (not needed); `files` and `modules` may be passed by a caller that already has them.
 */
export function detectReuse(root, { profile = null, files = null, modules = null } = {}) { // eslint-disable-line no-unused-vars
  files = files ?? listFiles(root, { gitignore: true });
  modules = modules ?? discoverModules(root, files);

  const layouts = [];
  const composables = [];
  const utils = [];
  const bases = [];
  const boiler = [];
  const tokens = { colorsXml: 0, dimensXml: 0, hardcodedColors: 0, hardcodedDp: 0 };
  let tooLarge = 0;

  for (const rel of files) {
    const ext = extOf(rel);
    const isCode = ext === '.kt' || ext === '.java';
    const lk = layoutKey(rel);
    const values = isValuesXml(rel);
    if (!isCode && lk === null && !values) continue;
    const set = sourceSet(rel);
    if (isCode && isTestSet(set)) continue;
    const abs = path.join(root, rel);
    let text;
    try {
      if (fs.statSync(abs).size > MAX_READ_BYTES) {
        tooLarge++;
        continue;
      }
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    if (values) {
      tokens.colorsXml += countOccurrences(text, '<color ');
      tokens.dimensXml += countOccurrences(text, '<dimen ');
    } else if (lk !== null) {
      const l = parseLayout(text);
      tokens.hardcodedColors += l.colors;
      tokens.hardcodedDp += l.dp;
      if (l.elements >= MIN_LAYOUT_ELEMENTS) layouts.push({ file: rel, key: lk, hash: sha(l.sig.join('\n')), count: l.elements });
    } else {
      const { code, skel } = mask(text);
      const lineOf = lineIndex(text);
      const java = ext === '.java';
      if (!TOKEN_FILE.test(path.posix.basename(rel)) && code.includes('androidx.compose')) {
        const t = composeTokens(code);
        tokens.hardcodedColors += t.colors;
        tokens.hardcodedDp += t.dp;
      }
      for (const b of findBaseClasses(skel, lineOf)) if (b.role) bases.push({ ...b, file: rel });
      for (const b of findBoilerplate(code, skel, lineOf)) boiler.push({ ...b, file: rel });
      for (const f of findFunctions(code, skel, lineOf, java)) {
        if (f.composable) {
          if (f.preview) continue;
          const calls = calledNames(f.bodySkel);
          if (calls.length >= MIN_COMPOSABLE_CALLS) {
            const types = paramTypes(f.params);
            composables.push({ file: rel, line: f.line, hash: sha(`${types.join(',')}|${calls.join(',')}`), types, calls });
          }
        } else if (!f.override) {
          const lines = f.bodyCode.split('\n').filter((l) => l.trim() !== '').length;
          if (lines >= MIN_UTIL_LINES) utils.push({ file: rel, line: f.line, name: f.name, lines, hash: sha(collapse(f.bodyCode)) });
        }
      }
    }
  }

  const duplicates = [];

  // Layouts: qualifier variants of one layout (layout/, layout-land/) are one layout, not copies.
  const layoutByKey = new Map();
  for (const l of layouts) if (!layoutByKey.has(l.key) || l.file < layoutByKey.get(l.key).file) layoutByKey.set(l.key, l);
  for (const group of groupBy([...layoutByKey.values()], (l) => l.hash).values()) {
    if (group.length < 2) continue;
    duplicates.push({
      kind: 'layout',
      signature: `${group[0].count} elements, structure ${group[0].hash.slice(0, 8)}`,
      files: sortedFiles(group.map((l) => ({ file: l.file, line: 1 }))),
    });
  }
  for (const group of groupBy(composables, (c) => c.hash).values()) {
    if (group.length < 2) continue;
    duplicates.push({
      kind: 'composable',
      signature: `(${group[0].types.join(', ')}) calls ${[...new Set(group[0].calls)].slice(0, 6).join(', ')}`,
      files: sortedFiles(group.map((c) => ({ file: c.file, line: c.line }))),
    });
  }
  for (const group of groupBy(utils, (u) => u.hash).values()) {
    if (new Set(group.map((u) => u.file)).size < 2) continue;
    duplicates.push({
      kind: 'util',
      signature: `${[...new Set(group.map((u) => u.name))].sort(byText).join(', ')} (${group[0].lines} lines)`,
      files: sortedFiles(group.map((u) => ({ file: u.file, line: u.line }))),
    });
  }
  sortGroups(duplicates);

  const baseClasses = [];
  for (const [role, list] of groupBy(bases, (b) => b.role)) {
    const seen = new Set();
    const classes = list
      .filter((b) => !seen.has(`${b.name}@${b.file}`) && seen.add(`${b.name}@${b.file}`))
      .map(({ name, file, line }) => ({ name, file, line }))
      .sort((a, b) => byText(a.name, b.name) || byText(a.file, b.file));
    if (classes.length >= 2) baseClasses.push({ role, classes });
  }
  baseClasses.sort((a, b) => byText(a.role, b.role));

  const boilerplate = [];
  for (const group of groupBy(boiler, (b) => `${b.kind}:${sha(b.text)}`).values()) {
    if (group.length < MIN_BOILERPLATE) continue;
    boilerplate.push({
      kind: group[0].kind,
      signature: group[0].kind === 'error-handling' ? `try/catch block (${group[0].lines} lines)` : `${group[0].kind.replace('-builder', '')} builder (${group[0].lines} lines)`,
      files: sortedFiles(group.map((b) => ({ file: b.file, line: b.line }))),
    });
  }
  sortGroups(boilerplate);

  const sharedModules = modules
    .filter((m) => m.path !== ':' && SHARED_NAMES.has(m.path.split(':').filter(Boolean).pop().toLowerCase()))
    .map((m) => modulePathName(m.path))
    .sort(byText);

  const groups = duplicates.length;
  const duplicationScore = groups >= 5 || baseClasses.some((b) => b.classes.length >= 3) ? 'high' : groups >= 2 ? 'medium' : 'low';
  return { duplicates, baseClasses, boilerplate, tokens, sharedModules, duplicationScore, tooLarge };
}
