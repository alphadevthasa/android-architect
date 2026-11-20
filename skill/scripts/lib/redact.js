// Secret redaction for everything written to .ai/ and the index. Matched values are never returned, only replaced.
// redact() / findSecrets() are authoritative. SECRET_RULES is a read-only description of the kinds: the token kinds are
// exact (non-global) patterns, the assignment kinds are coarse prefilters (the key-name rule), not the full matcher.

const KEY_NAME = /(^|[_\-.\s"])(api[_.\-]?key|secret|token|passw(or)?d|auth[_-]?token|credentials?)($|[_\-.\s"])/i;
const MIN_VALUE = 8;
const mark = (kind) => `[REDACTED:${kind}]`;
const isMarked = (v) => v.includes('[REDACTED:');

/** Key-name rule on word/segment boundaries; camelCase transitions also split segments (myApiKey yes, author no). */
export function isCredentialKey(key) {
  const split = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
  return KEY_NAME.test(split);
}

const PK = '(?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?';
// An unterminated BEGIN block runs to the end of the text (fail closed).
const PRIVATE_KEY_RE = new RegExp(`-----BEGIN ${PK}-----[\\s\\S]*?(?:-----END ${PK}-----|(?![\\s\\S]))`, 'g');

// A token after a scheme word: at least 8 characters with a digit, or it is long and mixes upper and lower case letters.
const looksLikeToken = (t) => (t.length >= 8 && /\d/.test(t)) || (t.length >= 24 && /[a-z]/.test(t) && /[A-Z]/.test(t));

const TOKEN_RULES = [
  { kind: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { kind: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: 'slack-token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  // The lookbehind keeps the scan linear: a match can only start at the beginning of a run of token characters.
  { kind: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Header-shaped credentials. Each regex matches one scheme word, a short whitespace run and ONE plain run of token
  // characters (no lookahead, no nesting: linear), and `decide` then keeps prose such as "bearer refresh" untouched.
  { kind: 'authorization-header', re: /\bauthorization[ \t]{0,16}[:=][ \t]{0,16}(?:(bearer|basic|token)[ \t]{1,16})?([A-Za-z0-9._~+/=-]+)/gi, decide: (scheme, token) => (scheme ? looksLikeToken(token) : token.length >= 20 && /\d/.test(token)) },
  { kind: 'bearer-token', re: /\b(?:bearer|basic|token)[ \t]{1,16}([A-Za-z0-9._~+/=-]+)/gi, decide: (token) => looksLikeToken(token) },
];

export const SECRET_RULES = Object.freeze([
  Object.freeze({ kind: 'private-key', re: new RegExp(PRIVATE_KEY_RE.source) }),
  ...TOKEN_RULES.map(({ kind, re }) => Object.freeze({ kind, re: new RegExp(re.source, re.flags.replace('g', '')) })),
  Object.freeze({ kind: 'signing-password', re: /\b(?:storePassword|keyPassword)\b/ }),
  Object.freeze({ kind: 'credential', re: KEY_NAME }),
]);

// Quoted value: a "..." / '...' string (escapes allowed) or a one-line Kotlin raw string. Group offsets are relative.
const VAL = '(?:"""(.*?)"""|(["\'])((?:\\\\.|(?!\\4)[^\\\\])*)\\4)'; // groups 3 raw, 4 quote, 5 text
const valueOf = (raw, str) => (raw !== undefined ? raw : str);
// Keys are bounded and anchored on a non-word boundary so the scan stays linear on long lines.
const SIGNING_QUOTED = /\b((?:storePassword|keyPassword)\s*(?:[=:]\s*|\s+))(?:"""(.*?)"""|(["'])((?:\\.|(?!\3)[^\\])*)\3)/g;
const SIGNING_BARE_PREFIX = /^(\s*(?:storePassword|keyPassword)\s*[=:]\s*)([\s\S]*)$/; // the rest is checked without backtracking
const SIGNING_BARE_VALUE = /^[^\s"'$()[\]][^\r\n"'()[\]]*$/;
const BUILD_CONFIG = /(\bbuildConfigField\s*\(?\s*["']String["']\s*,\s*["']([\w.\-]{1,64})["']\s*,\s*(["'])\\?")((?:\\.|(?!\\?"\3)[^\\])*)(\\?"\3)/g;
// Android string resource on one line: <string name="api_key" ...>value</string>. Bounded spans keep it linear.
const XML_STRING = /(<string\b[^>]{0,200}?\bname\s*=\s*["']([\w.\-]{1,64})["'][^>]{0,200}>)([^<]{1,4000})(<\/string>)/g;
// A credential-looking resource value: no whitespace, at least one digit (UI labels such as "Password" stay), not a reference.
const XML_SECRET_VALUE = /^(?![@?])(?=[^\d]*\d)\S+$/;
// key [: Type] (= | : | space) value   e.g. token = "x", const val API_KEY: String = "x", apiKey "x"
const ASSIGN = new RegExp(`(?<![\\w.\\-])(["']?([\\w.\\-]{1,64})["']?(?:\\s*:\\s*[A-Za-z_][\\w.<>?]{0,40})?(?:\\s*[=:]\\s*|\\s+))${VAL}`, 'g');
// "KEY"] = v   "KEY" to v   "KEY", v   e.g. manifestPlaceholders["K"] = "x", mapOf("k" to "x"), addHeader("K", "x")
const PAIR = new RegExp(`(["']([\\w.\\-]{1,64})["']\\s*(?:\\]\\s*=|\\s+to\\b|,)\\s*)${VAL}`, 'g');
// unquoted env / properties / shell style: KEY=value, export KEY=value, KEY: value
const BARE = /^([\s>*-]*(?:export\s+)?([A-Za-z_][\w.\-]{0,63})\s*[=:]\s*)(\S{8,})(.*)$/;

function redactLine(line, lineNo, hits) {
  let out = line;
  const hit = (kind) => hits.push({ kind, line: lineNo });
  const cred = (value) => value.length >= MIN_VALUE && !isMarked(value);

  for (const { kind, re, decide } of TOKEN_RULES) {
    out = out.replace(re, (m, ...groups) => {
      if (decide && !decide(...groups.slice(0, decide.length))) return m;
      hit(kind);
      return mark(kind);
    });
  }

  out = out.replace(SIGNING_QUOTED, (m, pre, raw, q, str) => {
    const v = valueOf(raw, str);
    if (v === '' || isMarked(v)) return m;
    hit('signing-password');
    return raw !== undefined ? `${pre}"""${mark('signing-password')}"""` : `${pre}${q}${mark('signing-password')}${q}`;
  });
  const bare = SIGNING_BARE_PREFIX.exec(out);
  if (bare) {
    const value = bare[2].trimEnd();
    if (SIGNING_BARE_VALUE.test(value) && !isMarked(value)) {
      hit('signing-password');
      out = `${bare[1]}${mark('signing-password')}${bare[2].slice(value.length)}`;
    }
  }
  out = out.replace(BUILD_CONFIG, (m, pre, key, _q, value, post) => {
    if (!cred(value) || !isCredentialKey(key)) return m;
    hit('credential');
    return `${pre}${mark('credential')}${post}`;
  });
  out = out.replace(XML_STRING, (m, pre, key, value, post) => {
    const v = value.trim();
    if (!cred(v) || !isCredentialKey(key) || !XML_SECRET_VALUE.test(v)) return m;
    hit('credential');
    return `${pre}${mark('credential')}${post}`;
  });
  const quoted = (m, pre, key, raw, q, str) => {
    const v = valueOf(raw, str);
    // A key quote must be closed right after the key: "token=" + token is code inside a literal, not an assignment.
    if (/["']/.test(pre[0]) && pre[1 + key.length] !== pre[0]) return m;
    if (raw !== undefined && !isCredentialKey(key)) return `${pre}"""${redactLine(raw, lineNo, hits)}"""`; // look inside
    if (!cred(v) || !isCredentialKey(key)) return m;
    hit('credential');
    return raw !== undefined ? `${pre}"""${mark('credential')}"""` : `${pre}${q}${mark('credential')}${q}`;
  };
  out = out.replace(ASSIGN, quoted).replace(PAIR, quoted);
  out = out.replace(BARE, (m, pre, key, value, rest) => {
    if (!isCredentialKey(key) || isMarked(value) || /[(){<[]/.test(value) || /[,?]$/.test(value)) return m;
    if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+;?$/.test(value)) return m; // dotted reference such as BuildConfig.TOKEN
    if (/^["']/.test(value)) return m; // quoted values belong to the rules above
    hit('credential');
    return `${pre}${mark('credential')}${rest}`;
  });
  return out;
}

/**
 * Replace secrets with `[REDACTED:<kind>]`. Returns { text, hits: [{ kind, line }] }, line numbers of the original text.
 * A private-key block becomes one placeholder followed by as many newlines as it spanned, so later lines keep their numbers.
 */
export function redact(text) {
  const hits = [];
  const src = String(text);
  const withoutKeys = src.replace(PRIVATE_KEY_RE, (m, offset) => {
    hits.push({ kind: 'private-key', line: src.slice(0, offset).split('\n').length });
    return mark('private-key') + '\n'.repeat(m.split('\n').length - 1);
  });
  const lines = withoutKeys.split('\n').map((l, i) => redactLine(l, i + 1, hits));
  hits.sort((a, b) => a.line - b.line);
  return { text: lines.join('\n'), hits };
}

export function findSecrets(text) {
  return redact(text).hits;
}

/** Redact a JSON-able value: string values are redacted, and a string under a credential key name is replaced whole. */
export function redactJson(value, key = '') {
  if (typeof value === 'string') {
    if (key && isCredentialKey(key) && value.length >= MIN_VALUE && !isMarked(value)) return mark('credential');
    return redact(value).text;
  }
  if (Array.isArray(value)) return value.map((v) => redactJson(v, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactJson(v, k)]));
  }
  return value;
}
