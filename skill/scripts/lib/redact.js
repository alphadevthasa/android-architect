// Secret redaction for everything written to .ai/ and the index. Matched values are never returned, only replaced.

const KEY_NAME = /(^|[_\-.\s"])(api[_-]?key|secret|token|passw(or)?d|auth[_-]?token|credentials?)($|[_\-.\s"])/i;
const MIN_VALUE = 8;
const mark = (kind) => `[REDACTED:${kind}]`;
const redacted = (v) => v.startsWith('[REDACTED:');

// Token-shaped secrets: the whole match is replaced.
const TOKEN_RULES = [
  { kind: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { kind: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: 'slack-token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g;

// Assignment rules: only the value (group `v`, preceded by `pre`) is replaced and the key is kept.
const SIGNING_QUOTED = /\b((?:storePassword|keyPassword)\s*(?:[=:]\s*|\s+)(["']))((?:(?!\2).)*)\2/g;
const SIGNING_BARE = /^(\s*(?:storePassword|keyPassword)\s*[=:]\s*)([^\s"'$()[\]][^\r\n"'()[\]]*?)(\s*)$/;
const BUILD_CONFIG = /(\bbuildConfigField\s*\(?\s*["']String["']\s*,\s*["']([^"']+)["']\s*,\s*(["'])\\?")((?:(?!\\?"\3).)*)(\\?"\3)/g;
const ASSIGN = /(["']?([\w.\-]+)["']?\s*(?:[=:]\s*|\s+)(["']))((?:(?!\3).)*)\3/g;

/** The same rules as redact(), reported without rewriting. */
export const SECRET_RULES = [
  { kind: 'private-key', re: PRIVATE_KEY_RE },
  ...TOKEN_RULES,
  { kind: 'signing-password', re: SIGNING_QUOTED },
  { kind: 'credential', re: ASSIGN },
];

function redactLine(line, lineNo, hits) {
  let out = line;
  const hit = (kind) => hits.push({ kind, line: lineNo });
  for (const { kind, re } of TOKEN_RULES) {
    out = out.replace(re, () => (hit(kind), mark(kind)));
  }
  out = out.replace(SIGNING_QUOTED, (m, pre, _q, value) => {
    if (value === '' || redacted(value)) return m;
    hit('signing-password');
    return `${pre}${mark('signing-password')}${_q}`;
  });
  out = out.replace(SIGNING_BARE, (m, pre, value, tail) => {
    if (redacted(value)) return m;
    hit('signing-password');
    return `${pre}${mark('signing-password')}${tail}`;
  });
  out = out.replace(BUILD_CONFIG, (m, pre, key, _q, value, post) => {
    if (value.length < MIN_VALUE || redacted(value) || !KEY_NAME.test(key)) return m;
    hit('credential');
    return `${pre}${mark('credential')}${post}`;
  });
  out = out.replace(ASSIGN, (m, pre, key, _q, value) => {
    if (value.length < MIN_VALUE || redacted(value) || !KEY_NAME.test(key)) return m;
    hit('credential');
    return `${pre}${mark('credential')}${_q}`;
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
    const startLine = src.slice(0, offset).split('\n').length;
    hits.push({ kind: 'private-key', line: startLine });
    return mark('private-key') + '\n'.repeat(m.split('\n').length - 1);
  });
  const lines = withoutKeys.split('\n').map((l, i) => redactLine(l, i + 1, hits));
  hits.sort((a, b) => a.line - b.line);
  return { text: lines.join('\n'), hits };
}

export function findSecrets(text) {
  return redact(text).hits;
}
