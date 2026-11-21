// Strict workflow checker (no YAML dependency). Test-only helper, never shipped.
// It parses only the small block-style YAML subset this repository's workflows use and FAILS
// CLOSED: flow collections, anchors, aliases, merge keys, quoted keys, tabs, CRLF, extra
// documents, unknown keys and unknown expressions are all violations. For the release
// workflow, run commands must equal the exact allowlisted scripts below.
export const ALLOWED_ACTIONS = ['actions/checkout', 'actions/setup-node'];

export const TAG_GUARD = `set -euo pipefail
if [ "$GITHUB_REF_TYPE" != "tag" ]; then
  echo "refusing: not a tag ref (a branch dispatch cannot publish)" >&2
  exit 1
fi
if ! [[ "$GITHUB_REF_NAME" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then
  echo "refusing: tag is not vX.Y.Z" >&2
  exit 1
fi
version="$(node -p "require('./package.json').version")"
if [ "$GITHUB_REF_NAME" != "v$version" ]; then
  echo "refusing: tag does not match package.json version" >&2
  exit 1
fi
if [ "$(git rev-parse HEAD)" != "$GITHUB_SHA" ]; then
  echo "refusing: checked out commit is not the tagged commit" >&2
  exit 1
fi`;
export const MAIN_GUARD = `set -euo pipefail
git merge-base --is-ancestor HEAD origin/main`;
export const POLICY_CMD = 'RELEASE_REQUIRE_PINNED=1 node --test --import ./test/helpers/no-network.mjs test/release-policy.test.js';
export const PUBLISH_CMD = 'npm publish --provenance --access public --ignore-scripts';
const RELEASE_RUNS = new Map([[TAG_GUARD, 'tag-guard'], [MAIN_GUARD, 'main-guard'], ['npm test', 'npm-test'], [POLICY_CMD, 'policy'], [PUBLISH_CMD, 'publish']]);
const CI_RUNS = new Map([['npm test', 'npm-test']]);

const EXPR_OK = {
  ci: new Set(['github.workflow', 'github.ref', "github.event_name == 'pull_request'", 'matrix.os', 'matrix.node']),
  release: new Set(['secrets.NPM_TOKEN']),
};

class ParseError extends Error {}
const bad = (n, why) => { throw new ParseError(`line ${n + 1}: ${why}`); };

function parseYaml(text) {
  if (text.includes('\r')) throw new ParseError('carriage return');
  if (text.includes('\t')) throw new ParseError('tab character');
  const L = text.split('\n').map((raw, n) => ({ n, raw, ind: raw.length - raw.trimStart().length, t: raw.trim() }));
  let idx = 0;
  const skippable = (e) => e.t === '' || e.t.startsWith('#');
  const peek = () => { while (idx < L.length && skippable(L[idx])) idx++; return idx < L.length ? L[idx] : null; };
  const stripComment = (v) => (v.startsWith('#') ? '' : v.replace(/\s+#.*$/, '').trim());
  const scalarOk = (e, v) => { if (/^[{[&*!|>%@`]/.test(v) || v.startsWith('<<')) bad(e.n, `unsupported value "${v.slice(0, 20)}"`); };

  function parseMap(ind) {
    const pairs = [];
    for (;;) {
      const e = peek();
      if (!e || e.ind < ind) break;
      if (e.ind > ind) bad(e.n, 'unexpected indentation');
      const m = /^([A-Za-z_][\w-]*):(?: +(.*))?$/.exec(e.t);
      if (!m) bad(e.n, 'unsupported syntax (quoted key, flow, list or stray text)');
      if (pairs.some((p) => p.key === m[1])) bad(e.n, `duplicate key ${m[1]}`);
      idx++;
      const val = m[2] === undefined ? '' : stripComment(m[2]);
      let node;
      if (val === '') {
        const nx = peek();
        if (nx && nx.ind > ind) node = nx.t === '-' || nx.t.startsWith('- ') ? parseList(nx.ind) : parseMap(nx.ind);
        else node = { kind: 'null' };
      } else if (val === '|' || val === '|-') {
        const body = [];
        while (idx < L.length && (L[idx].t === '' || L[idx].ind > ind)) body.push(L[idx++]);
        while (body.length && body[body.length - 1].t === '') body.pop();
        const min = Math.min(...body.filter((b) => b.t !== '').map((b) => b.ind), Infinity);
        node = { kind: 'block', v: body.map((b) => b.raw.slice(Math.min(min, b.raw.length))).join('\n') };
      } else if (val === '{}') node = { kind: 'empty' };
      else {
        scalarOk(e, val);
        node = { kind: 'scalar', v: val };
        const nx = peek();
        if (nx && nx.ind > ind) bad(nx.n, 'multi-line scalar');
      }
      pairs.push({ key: m[1], node, n: e.n });
    }
    return { kind: 'map', pairs };
  }

  function parseList(ind) {
    const items = [];
    for (;;) {
      const e = peek();
      if (!e || e.ind < ind) break;
      if (e.ind > ind) bad(e.n, 'unexpected indentation');
      if (!(e.t === '-' || e.t.startsWith('- '))) bad(e.n, 'expected a list item');
      const rest = e.t.slice(1).trimStart();
      if (rest === '') bad(e.n, 'nested list item');
      if (/^[A-Za-z_][\w-]*:(?: |$)/.test(rest)) {
        const itemInd = ind + (e.t.length - rest.length);
        L[idx] = { ...e, ind: itemInd, t: rest, raw: ' '.repeat(itemInd) + rest };
        items.push(parseMap(itemInd));
      } else {
        const v = stripComment(rest);
        scalarOk(e, v.replace(/^(['"])(.*)\1$/, '$2').length ? v : '');
        if (/^[{[&*]/.test(v)) bad(e.n, 'unsupported list item');
        idx++;
        items.push({ kind: 'scalar', v });
      }
    }
    return { kind: 'list', items };
  }

  const first = peek();
  if (!first) throw new ParseError('empty file');
  if (first.ind !== 0) bad(first.n, 'top level must start at column 0');
  const root = parseMap(0);
  const rest = peek();
  if (rest) bad(rest.n, 'unparsed content');
  return root;
}

const get = (m, k) => (m?.kind === 'map' ? m.pairs.find((p) => p.key === k)?.node : undefined);
const keys = (m) => (m?.kind === 'map' ? m.pairs.map((p) => p.key) : []);
const val = (n) => (n && (n.kind === 'scalar' || n.kind === 'block') ? n.v : undefined);
const unq = (s) => (typeof s === 'string' ? s.replace(/^(['"])(.*)\1$/, '$2') : s);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const permEntries = (n) => (n?.kind === 'map' ? n.pairs.map((p) => `${p.key}: ${unq(val(p.node))}`) : null);

export function checkWorkflow(text, kind) {
  const v = [];
  const unpinned = [];
  const add = (c) => v.push(c);
  const release = kind === 'release';

  // Raw text checks (comments included on purpose).
  if (/pull_request_target/.test(text)) add('pull_request_target');
  if (/self-hosted|self_hosted/.test(text)) add('self-hosted-runner');
  if (/continue-on-error/.test(text)) add('continue-on-error');
  if (/NODE_OPTIONS/.test(text)) add('node-options');
  if (/github\.token|GITHUB_TOKEN|toJSON|fromJSON/.test(text)) add('token-or-json-expression');
  const exprs = [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1].trim());
  if ((text.match(/\$\{\{/g) ?? []).length !== exprs.length) add('unterminated-expression');
  for (const e of exprs) if (!EXPR_OK[kind].has(e)) add('unexpected-expression');
  const count = (re) => (text.match(re) ?? []).length;
  if (release) {
    if (count(/\bsecrets\b/g) !== 1 || count(/secrets\.NPM_TOKEN\b/g) !== 1) add('release-secret-count');
    if (count(/NODE_AUTH_TOKEN/g) !== 1) add('release-token-count');
    if (count(/id-token/g) !== 1) add('release-id-token-scope');
  } else {
    if (/\bsecrets\b/.test(text)) add('ci-secrets');
    if (/id-token|NODE_AUTH_TOKEN/.test(text)) add('ci-write-permission');
    if (/:\s*write\b/.test(text)) add('ci-write-permission');
  }

  let root;
  try { root = parseYaml(text); } catch (e) { add(`yaml-unsupported: ${e.message}`); return { violations: [...new Set(v)], unpinned }; }

  for (const k of keys(root)) if (!['name', 'on', 'permissions', 'concurrency', 'jobs'].includes(k)) add(`top-key:${k}`);

  // Triggers
  const on = get(root, 'on');
  const trig = keys(on);
  const push = get(on, 'push');
  if (release) {
    if (!same(trig, ['workflow_dispatch', 'push']) || get(on, 'workflow_dispatch')?.kind !== 'null') add('release-triggers');
    const tagsOnly = same(keys(push), ['tags']) && get(push, 'tags')?.kind === 'list' && get(push, 'tags').items.length === 1 && unq(val(get(push, 'tags').items[0])) === 'v*';
    if (!tagsOnly) add('release-push-tags-only');
  } else {
    if (!same(trig, ['push', 'pull_request']) || get(on, 'pull_request')?.kind !== 'null') add('ci-triggers');
    const br = get(push, 'branches');
    if (!(same(keys(push), ['branches']) && br?.kind === 'list' && br.items.length === 1 && unq(val(br.items[0])) === 'main')) add('ci-push-branch-main');
  }

  // Top-level permissions
  const tp = get(root, 'permissions');
  if (release) { if (tp?.kind !== 'empty') add('release-top-permissions'); }
  else if (!same(permEntries(tp) ?? ['x'], ['contents: read'])) add('ci-top-permissions');

  // Concurrency
  const cc = get(root, 'concurrency');
  const cancel = unq(val(get(cc, 'cancel-in-progress')));
  if (!same(keys(cc), ['group', 'cancel-in-progress'])) add(release ? 'release-concurrency' : 'ci-concurrency');
  else if (release && (unq(val(get(cc, 'group'))) !== 'release' || cancel !== 'false')) add('release-concurrency');

  // Jobs
  const jobs = get(root, 'jobs');
  const jobNames = keys(jobs);
  if (!jobNames.length) add('no-jobs');
  if (release && !same(jobNames, ['verify', 'publish'])) add('release-jobs');
  if (!release && !same(jobNames, ['test'])) add('ci-jobs');
  const JOB_KEYS = release ? ['runs-on', 'timeout-minutes', 'permissions', 'environment', 'needs', 'steps'] : ['name', 'runs-on', 'timeout-minutes', 'permissions', 'strategy', 'steps'];
  for (const jn of jobNames) {
    const job = get(jobs, jn);
    for (const k of keys(job)) if (!JOB_KEYS.includes(k)) add(`job-key:${jn}.${k}`);
    const to = Number(unq(val(get(job, 'timeout-minutes'))));
    if (!Number.isInteger(to) || to < 1 || to > 30) add(`job-timeout:${jn}`);
    const perms = permEntries(get(job, 'permissions'));
    const wantPerms = release && jn === 'publish' ? ['contents: read', 'id-token: write'] : ['contents: read'];
    if (!perms || !same(perms, wantPerms)) add(release ? `release-job-permissions:${jn}` : 'ci-top-permissions');
    const runsOn = unq(val(get(job, 'runs-on')));
    if (release ? runsOn !== 'ubuntu-latest' : runsOn !== '${{ matrix.os }}') add(release ? 'release-runner' : 'ci-runner');
    if (release) {
      const env = get(job, 'environment');
      if (jn === 'publish' ? unq(val(env)) !== 'release' : env) add('release-environment');
      const needs = get(job, 'needs');
      if (jn === 'publish' ? unq(val(needs)) !== 'verify' : needs) add('release-needs');
    } else {
      const st = get(job, 'strategy');
      const mx = get(st, 'matrix');
      const inc = get(mx, 'include');
      const okStrat = same(keys(st).filter((k) => k !== 'fail-fast'), ['matrix']) && same(keys(mx), ['include']) && inc?.kind === 'list' &&
        inc.items.length > 0 && inc.items.every((i) => same(keys(i), ['os', 'node']) && ['ubuntu-latest', 'macos-latest'].includes(unq(val(get(i, 'os')))) && /^\d+$/.test(unq(val(get(i, 'node')))));
      if (!okStrat) add('ci-strategy');
    }

    const steps = get(job, 'steps');
    if (steps?.kind !== 'list' || !steps.items.length) { add(`job-no-steps:${jn}`); continue; }
    const labels = [];
    for (const s of steps.items) {
      if (s.kind !== 'map') { add('step-not-map'); continue; }
      for (const k of keys(s)) if (!['name', 'uses', 'with', 'run', 'shell', 'env'].includes(k)) add(`step-key:${k}`);
      const uses = get(s, 'uses');
      const run = get(s, 'run');
      if (!!uses === !!run) add('step-needs-exactly-one-of-uses-run');
      if (get(s, 'shell') && (!run || unq(val(get(s, 'shell'))) !== 'bash')) add('step-shell');
      const env = get(s, 'env');
      if (env) {
        const okEnv = release && jn === 'publish' && same(keys(env), ['NODE_AUTH_TOKEN']) && val(get(env, 'NODE_AUTH_TOKEN')) === '${{ secrets.NPM_TOKEN }}' &&
          run && val(run) === PUBLISH_CMD;
        if (!okEnv) add('step-env');
      }
      if (uses) {
        const [name, ref = ''] = unq(val(uses)).split('@');
        const w = get(s, 'with');
        if (!ALLOWED_ACTIONS.includes(name)) { add(`disallowed-action:${unq(val(uses))}`); labels.push('bad-action'); continue; }
        if (!/^[\w.-]+$/.test(ref)) add('action-ref-format');
        else if (!/^[0-9a-f]{40}$/.test(ref)) unpinned.push(`${name}@${ref}`);
        labels.push(name);
        const wk = keys(w);
        if (name === 'actions/checkout') {
          if (unq(val(get(w, 'persist-credentials'))) !== 'false') add('checkout-persist-credentials');
          if (!wk.every((k) => (release ? ['persist-credentials', 'fetch-depth'] : ['persist-credentials']).includes(k))) add('with-key:checkout');
          if (release && unq(val(get(w, 'fetch-depth'))) !== '0') add('release-checkout-fetch-depth');
        } else {
          if (!wk.every((k) => ['node-version', 'registry-url'].includes(k))) add('with-key:setup-node');
          const nv = unq(val(get(w, 'node-version')));
          if (release ? !/^\d+\.\d+\.\d+$/.test(nv ?? '') : nv !== '${{ matrix.node }}') add('release-setup-node');
          const ru = unq(val(get(w, 'registry-url')));
          if (release && (jn === 'publish' ? ru !== 'https://registry.npmjs.org' : ru !== undefined)) add('release-setup-node');
          if (!release && ru !== undefined) add('release-setup-node');
        }
      } else if (run) {
        const body = (val(run) ?? '').replace(/\s+$/, '');
        const lab = (release ? RELEASE_RUNS : CI_RUNS).get(body);
        if (!lab) { add(`run-not-allowed:${jn}`); labels.push('bad-run'); } else labels.push(lab);
        if (/\$\{\{/.test(body)) add(`run-interpolation:${jn}`);
      }
    }
    const co = 'actions/checkout';
    const sn = 'actions/setup-node';
    let want;
    if (!release) want = [co, sn, 'npm-test'];
    else if (jn === 'verify') want = [co, sn, 'tag-guard', 'main-guard', 'npm-test', 'policy'];
    else want = [co, sn, 'tag-guard', 'main-guard', 'publish'];
    if (JSON.stringify(labels) !== JSON.stringify(want)) add(release ? `release-steps:${jn}` : 'ci-steps');
    if (release && jn === 'publish' && labels[labels.length - 1] !== 'publish') add('release-publish-not-last');
  }
  return { violations: [...new Set(v)], unpinned };
}

// Golden comparison of release.yml: only the pin comments and the action tag/SHA refs are ignored.
export function normalizeForGolden(text) {
  return text.split('\n').filter((l) => !/^\s*# UNVERIFIED pin:/.test(l)).join('\n').replace(/\b(actions\/(?:checkout|setup-node))@[\w.-]+/g, '$1@<ref>');
}
