import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, findSecrets, SECRET_RULES } from '../skill/scripts/lib/redact.js';
import { listFiles, SECRET_FILE_PATTERNS } from '../skill/scripts/lib/walk.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GH = 'ghp_' + 'FAKEfake'.repeat(5).slice(0, 36);
const GOOGLE = 'AIza' + 'FAKEfake'.repeat(5).slice(0, 35);
const JWT = ['eyJ' + 'x'.repeat(12), 'y'.repeat(12), 'z'.repeat(12)].join('.');

// [kind, input] pairs: the secret part must be gone and the placeholder present.
const CASES = [
  ['private-key', '-----BEGIN EC PRIVATE KEY-----\nFAKEKEYFAKEKEY\n-----END EC PRIVATE KEY-----'],
  ['private-key', '-----BEGIN PRIVATE KEY-----\nFAKEKEYFAKEKEY\n-----END PRIVATE KEY-----'],
  ['aws-access-key', 'id = AKIAFAKEFAKEFAKEFAKE'],
  ['google-api-key', `key: ${GOOGLE}`],
  ['github-token', `x ${GH} y`],
  ['slack-token', 'xoxb-' + 'x'.repeat(12)],
  ['jwt', `Bearer ${JWT}`],
  ['signing-password', 'storePassword "fake-store-pass-123"'],
  ['signing-password', 'keyPassword = "fake-key-pass-123"'],
  ['signing-password', 'storePassword=fake-store-pass-123'],
  ['credential', 'val apiKey = "fake-api-key-value"'],
  ['credential', 'String token = "fake-token-value";'],
  ['credential', 'API_SECRET = "fake-secret-value"'],
  ['credential', 'buildConfigField "String", "API_KEY", "\\"fake-api-key-value-123\\""'],
];

for (const [kind, input] of CASES) {
  test(`redacts ${kind}: ${input.split('\n')[0].slice(0, 24)}`, () => {
    const r = redact(input);
    assert.ok(r.text.includes(`[REDACTED:${kind}]`), 'placeholder missing');
    assert.deepEqual(r.hits.map((h) => h.kind), [kind]);
    assert.deepEqual(findSecrets(input), r.hits);
  });
}

test('no value survives redaction', () => {
  for (const [, input] of CASES) {
    const t = redact(input).text;
    for (const frag of ['fake-', 'FAKEKEY', 'AKIAFAKE', GH, GOOGLE, JWT, 'xoxb-']) {
      assert.ok(!t.includes(frag), 'a secret value survived redaction');
    }
  }
});

test('assignment keeps the key and replaces only the value', () => {
  const r = redact('storePassword "fake-store-pass-123"\nx');
  assert.equal(r.text, 'storePassword "[REDACTED:signing-password]"\nx');
  assert.deepEqual(r.hits, [{ kind: 'signing-password', line: 1 }]);
  assert.equal(redact('storePassword=fake-store-pass-123').text, 'storePassword=[REDACTED:signing-password]');
  assert.equal(
    redact('buildConfigField "String", "API_KEY", "\\"fake-api-key-value-123\\""').text,
    'buildConfigField "String", "API_KEY", "\\"[REDACTED:credential]\\""',
  );
});

test('hits carry original line numbers, also after a multi-line private key', () => {
  const text = ['a', '-----BEGIN RSA PRIVATE KEY-----', 'FAKE', 'FAKE', '-----END RSA PRIVATE KEY-----', 'token = "fake-token-value"'].join('\n');
  const r = redact(text);
  assert.deepEqual(r.hits, [{ kind: 'private-key', line: 2 }, { kind: 'credential', line: 6 }]);
  assert.equal(r.text.split('\n').length, text.split('\n').length);
});

test('no false positives', () => {
  for (const s of [
    'versionName "1.2.3"',
    'val token = BuildConfig.TOKEN',
    'storePassword = System.getenv("STORE_PASSWORD")',
    'storePassword = props["storePassword"]',
    'token = "short"',
    'author = "John Smith Long"',
    'tokenizerName = "abcdefghij"',
    'secretary = "abcdefghijkl"',
    'implementation "com.squareup.retrofit2:retrofit:2.9.0"',
  ]) {
    assert.equal(redact(s).hits.length, 0, `false positive on: ${s}`);
    assert.equal(redact(s).text, s);
  }
});

test('credential key matches on segment boundaries, case-insensitively', () => {
  for (const s of ['PASSWORD = "abcdefghij"', 'db.password = "abcdefghij"', 'api-key: "abcdefghij"', 'Credentials = "abcdefghij"', 'AUTH_TOKEN = "abcdefghij"']) {
    assert.deepEqual(redact(s).hits.map((h) => h.kind), ['credential'], s);
  }
});

test('redaction is idempotent', () => {
  const once = redact('token = "fake-token-value"\nstorePassword=fake-pass-123').text;
  assert.equal(redact(once).text, once);
  assert.equal(redact(once).hits.length, 0);
});

test('SECRET_RULES lists every kind', () => {
  const kinds = new Set(SECRET_RULES.map((r) => r.kind));
  for (const k of ['private-key', 'aws-access-key', 'google-api-key', 'github-token', 'slack-token', 'jwt', 'signing-password', 'credential']) {
    assert.ok(kinds.has(k), k);
  }
});

test('walk skips the new secret file names', () => {
  const names = ['signing.properties', 'secrets.properties', 'a.pem', 'b.key', 'credentials.json', 'Service-Account-prod.json'];
  for (const n of names) assert.ok(SECRET_FILE_PATTERNS.some((re) => re.test(n)), n);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-redact-'));
  try {
    for (const n of [...names, 'ok.kt']) fs.writeFileSync(path.join(root, n), 'x');
    assert.deepEqual(listFiles(root), ['ok.kt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
