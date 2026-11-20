import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactJson, findSecrets, SECRET_RULES } from '../skill/scripts/lib/redact.js';
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
  ['credential', 'const val API_KEY: String = "fake-const-api-key-1"'],
  ['credential', 'private val clientSecret: String = "fake-client-secret-1"'],
  ['credential', 'manifestPlaceholders["MAPS_API_KEY"] = "fake-maps-api-key-1"'],
  ['credential', 'val m = mapOf("api_key" to "fake-map-api-key-1")'],
  ['credential', 'client.addHeader("X-Api-Key", "fake-header-api-key-1")'],
  ['credential', 'val authToken = """fake-raw-string-secret"""'],
  ['credential', 'val raw = """{"token": "fake-raw-token-12345"}"""'],
  ['credential', 'export SERVICE_TOKEN=fake-env-token-12345'],
  ['credential', 'DB_PASSWORD: fake-env-password-1'],
  ['credential', 'api.key=fake-local-secret'],
  ['private-key', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nFAKEKEYFAKEKEY\n-----END ENCRYPTED PRIVATE KEY-----'],
  ['private-key', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nFAKEKEYFAKEKEY\n-----END PGP PRIVATE KEY BLOCK-----'],
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
    'Log.d(TAG, "token=" + token + " loaded")',
    'println("password: " + pwd)',
    'val token = BuildConfig.TOKEN',
    'storePassword = System.getenv("STORE_PASSWORD")',
    'storePassword = props["storePassword"]',
    'token = "short"',
    'author = "John Smith Long"',
    'tokenizerName = "abcdefghij"',
    'secretary = "abcdefghijkl"',
    'val token = BuildConfig.TOKEN',
    'token = BuildConfig.TOKEN',
    'password: String,',
    'implementation "com.squareup.retrofit2:retrofit:2.9.0"',
  ]) {
    assert.equal(redact(s).hits.length, 0, `false positive on: ${s}`);
    assert.equal(redact(s).text, s);
  }
});

test('credential key matches on segment boundaries, case-insensitively', () => {
  for (const s of ['myApiKey = "abcdefghij"', 'clientSecret = "abcdefghij"', 'secretKey = "abcdefghij"', 'authToken = "abcdefghij"', 'apiToken = "abcdefghij"', 'PASSWORD = "abcdefghij"', 'db.password = "abcdefghij"', 'api-key: "abcdefghij"', 'Credentials = "abcdefghij"', 'AUTH_TOKEN = "abcdefghij"']) {
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

test('unterminated private key block redacts to the end and keeps the line count', () => {
  const text = 'a\n-----BEGIN RSA PRIVATE KEY-----\nFAKEKEY\nFAKEKEY2\n';
  const r = redact(text);
  assert.ok(!r.text.includes('FAKEKEY'));
  assert.equal(r.text.split('\n').length, text.split('\n').length);
  assert.deepEqual(r.hits, [{ kind: 'private-key', line: 2 }]);
});

test('escaped quotes in a value stay inside the value', () => {
  assert.equal(redact('token = "abcdefgh\\"ij-fake"').text, 'token = "[REDACTED:credential]"');
});

test('redactJson keeps JSON valid and redacts credential values and secret strings', () => {
  const out = redactJson({ token: 'abcdefgh"ij', note: `see ${GH}`, list: ['AKIAFAKEFAKEFAKEFAKE', 'plain'], n: 3, author: 'John Smith Long' });
  const back = JSON.parse(JSON.stringify(out, null, 2));
  assert.equal(back.token, '[REDACTED:credential]');
  assert.equal(back.note, 'see [REDACTED:github-token]');
  assert.deepEqual(back.list, ['[REDACTED:aws-access-key]', 'plain']);
  assert.equal(back.n, 3);
  assert.equal(back.author, 'John Smith Long');
});

test('long single lines redact in linear time', () => {
  const lines = [
    'a'.repeat(1024 * 1024),
    'deadbeef'.repeat(128 * 1024),
    'a "'.repeat(300 * 1024),
    'k = '.repeat(250 * 1024),
    'a.b-'.repeat(256 * 1024),
    ...['storePassword=x', 'keyPassword = ', 'storePassword "', 'token = ', 'const val API_KEY: String', 'export TOKEN=', '"k", ', 'buildConfigField "String", "API_KEY", "'].flatMap(
      (head) => [head + ' '.repeat(1024 * 1024) + 'y', ' '.repeat(1024 * 1024) + head, (head + ' ').repeat(100 * 1024)],
    ),
  ];
  for (const l of lines) {
    const t0 = Date.now();
    redact(l);
    assert.ok(Date.now() - t0 < 1000, 'redact is too slow on a long line');
  }
});

test('an Android string resource with a credential name is redacted; labels and references stay', () => {
  const value = 'k3y' + 'Value' + '0042';
  const r = redact(`<string name="backend_api_key">${value}</string>\n<string name="password">Password</string>\n<string name="token">@string/x</string>`);
  assert.equal(r.text.split('\n')[0], '<string name="backend_api_key">[REDACTED:credential]</string>');
  assert.ok(!r.text.includes(value), 'value removed');
  assert.deepEqual(r.hits, [{ kind: 'credential', line: 1 }]);
});

test('Authorization and Bearer credentials are redacted; prose is not', () => {
  const digits = 'abcdef1234567890ABCDEF';
  const letters = 'AbcdefGhijklMnopqrStuvwxYz'; // 26 chars, mixed case, no digit
  for (const line of [
    `Authorization: Bearer ${digits}`,
    `authorization=${digits}-xyzxyz`,
    `curl -H "Authorization: Basic ${digits}=="`,
    `Bearer ${digits}`,
    `bearer\t${digits}`,
    `Authorization: Bearer ${letters}`,
    `Token ${letters}`,
    `Authorization: ${digits}0123`,
  ]) {
    const r = redact(line);
    assert.ok(!r.text.includes(digits) && !r.text.includes(letters), line);
    assert.ok(r.hits.length >= 1, line);
  }
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  assert.deepEqual(redact(`Authorization: Bearer ${jwt}`).hits.map((h) => h.kind), ['jwt']);
  for (const prose of ['the bearer of news', 'Auth if you use bearer refresh.', 'basic usage of the token refresh', 'Token budget exceeded', 'Authorization: required', 'authorization = none', 'Bearer abcdefghijklmnopqrstuvwx', 'basic 2 things']) {
    assert.equal(redact(prose).text, prose, prose);
  }
});

test('the header rules are linear on 1 MB hostile single lines', () => {
  const MB = 1024 * 1024;
  const lines = [
    'authorization='.repeat(100000),
    'Authorization: '.repeat(70000),
    'Bearer '.repeat(150000),
    'bearer'.repeat(170000),
    'Bearer' + 'a'.repeat(MB),
    'Bearer ' + 'aB'.repeat(MB / 2),
    'Bearer ' + ' '.repeat(MB) + 'x',
    'Authorization:' + ' '.repeat(MB),
    'authorization=a'.repeat(70000),
    'Bearer a '.repeat(110000),
    'token '.repeat(170000),
    'basic\t'.repeat(170000),
    'Authorization: Bearer ' + '1'.repeat(MB),
    ('Authorization: Bearer ' + 'x'.repeat(30) + ' ').repeat(20000),
  ];
  for (const l of lines) {
    const t0 = Date.now();
    redact(l);
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `slow (${ms} ms) on ${l.slice(0, 30)}`);
  }
});
