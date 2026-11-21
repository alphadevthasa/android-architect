// Eval suite for the tool itself. Deterministic, no network, always runs (npm test and npm run eval).
// Part 1: in-repo fixtures against golden profiles, candidate paths and canned recommendations.
// Part 2: pinned real apps (apps.json), asserted only when test/eval/apps/<id> exists.
// The model-dependent flow is documentation only (README.md) and never runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateApps, ERAS } from '../../dev/lib/apps-schema.mjs';
import { stripToAllowlist, findNodeDiscoverable } from '../../dev/lib/strip.mjs';
import { projectProfile, projectCandidates } from '../../dev/lib/project.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', '..', 'skill', 'scripts');
const noNetwork = path.join(here, '..', 'helpers', 'no-network.mjs');
const goldenDir = path.join(here, 'golden');
const FIXTURES = ['legacy-java-mvp', 'modern-compose', 'mixed', 'feature-app', 'reuse-app', 'secrets', 'insecure-app'];
const MIN_JUSTIFICATION = 20;

const node = (script, ...args) => {
  const r = spawnSync(process.execPath, ['--import', noNetwork, path.join(scripts, script), ...args], { encoding: 'utf8', cwd: os.tmpdir(), timeout: 30000 });
  assert.equal(r.error, undefined, `${script}: ${r.error?.message}`);
  return r;
};
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// One scan + candidates run per target, cached; the profile is written to a temp file for recommend-check.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-eval-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const cache = new Map();
function analyse(name, dir) {
  if (!cache.has(name)) {
    const scan = node('scan.js', dir);
    assert.equal(scan.status, 0, `scan ${name}: ${scan.stderr}`);
    const cand = node('candidates.js', dir);
    assert.equal(cand.status, 0, `candidates ${name}: ${cand.stderr}`);
    const profileFile = path.join(tmp, `${name}.profile.json`);
    fs.writeFileSync(profileFile, scan.stdout);
    cache.set(name, { profile: JSON.parse(scan.stdout), candidates: JSON.parse(cand.stdout), profileFile });
  }
  return cache.get(name);
}

function guardrail(profileFile, recsFile, adrDir = null) {
  const r = node('recommend-check.js', recsFile, '--profile', profileFile, ...(adrDir ? ['--adr-dir', adrDir] : []));
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* exit 2 prints no JSON */ }
  return { status: r.status, out, rules: out ? [...new Set(out.violations.map((v) => v.rule))].sort() : [] };
}

const justified = (s) => typeof s.justification === 'string' && s.justification.trim().length >= MIN_JUSTIFICATION;
const stepsOf = (recs) => (Array.isArray(recs.steps) ? recs.steps : []);
// must-not-recommend: some unjustified step moves a forbidden `dimension` to one of its forbidden `to` ids.
const violatesForbid = (rule, recs) => stepsOf(recs).some((s) => rule.forbid.some((f) => s.dimension === f.dimension && f.to.includes(s.to)) && !justified(s));
// must-recommend: at least one step moves `dimension` to one of the `anyOf` ids.
const satisfiesRequire = (rule, recs) => stepsOf(recs).some((s) => s.dimension === rule.require.dimension && rule.require.anyOf.includes(s.to));

test('rule evaluators detect what they claim to (negative controls)', () => {
  const bad = { steps: [{ dimension: 'presentation', to: 'udf-stateflow' }] };
  const ok = { steps: [{ dimension: 'presentation', to: 'udf-stateflow', justification: 'x'.repeat(MIN_JUSTIFICATION) }] };
  const rule = { forbid: [{ dimension: 'presentation', to: ['udf-stateflow'] }] };
  assert.equal(violatesForbid(rule, bad), true);
  assert.equal(violatesForbid(rule, ok), false);
  assert.equal(violatesForbid(rule, { steps: [] }), false);
  const req = { require: { dimension: 'language', anyOf: ['kotlin'] } };
  assert.equal(satisfiesRequire(req, { steps: [{ dimension: 'language', to: 'kotlin' }] }), true);
  assert.equal(satisfiesRequire(req, bad), false);
});

test('justification threshold: 19 characters fail, 20 pass', () => {
  const rule = { forbid: [{ dimension: 'presentation', to: ['udf-stateflow'] }] };
  const step = (n) => ({ steps: [{ dimension: 'presentation', to: 'udf-stateflow', justification: 'x'.repeat(n) }] });
  assert.equal(violatesForbid(rule, step(MIN_JUSTIFICATION - 1)), true);
  assert.equal(violatesForbid(rule, step(MIN_JUSTIFICATION)), false);
  assert.equal(MIN_JUSTIFICATION, 20);
});

test('every in-repo fixture has a golden file and nothing else sits in golden/', () => {
  const found = fs.readdirSync(goldenDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(found, [...FIXTURES].sort());
});

for (const name of FIXTURES) {
  const golden = json(path.join(goldenDir, `${name}.json`));
  const dir = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

  test(`${name}: golden shape`, () => {
    assert.equal(golden.fixture, name);
    assert.deepEqual(Object.keys(golden).sort(), ['candidates', 'fixture', 'profile', 'rules']);
    for (const r of golden.rules) {
      assert.ok(['guardrail', 'must-not-recommend', 'must-recommend'].includes(r.kind), `${r.id}: kind`);
      assert.ok(r.cases.length > 0, `${r.id}: no cases`);
    }
  });

  test(`${name}: scan profile matches the golden exactly`, () => {
    assert.deepEqual(projectProfile(analyse(name, dir).profile), golden.profile);
  });

  test(`${name}: candidate paths match the golden exactly (stable order)`, () => {
    assert.deepEqual(projectCandidates(analyse(name, dir).candidates), golden.candidates);
  });

  for (const rule of golden.rules) {
    for (const c of rule.cases) {
      test(`${name}: ${rule.kind} ${rule.id} (${c.recs}, expect ${c.expect})`, () => {
        const recsFile = path.join(goldenDir, c.recs);
        const recs = json(recsFile);
        const g = guardrail(analyse(name, dir).profileFile, recsFile, c.adr ? path.join(goldenDir, c.adr) : null);
        if (rule.kind === 'guardrail') {
          if (c.expect === 'pass') {
            assert.equal(g.status, 0, JSON.stringify(g.out));
            assert.equal(g.out.ok, true);
            assert.deepEqual(g.rules, []);
          } else {
            assert.equal(g.status, 1, 'guardrail must exit 1');
            assert.equal(g.out.ok, false);
            assert.deepEqual(g.rules, [...c.rules].sort());
          }
        } else if (rule.kind === 'must-not-recommend') {
          const violated = violatesForbid(rule, recs);
          assert.equal(violated, c.expect === 'violate');
          // A forbidden unjustified jump must also be caught by the guardrail itself.
          if (violated) {
            assert.equal(g.status, 1, 'guardrail must reject the forbidden step');
            assert.deepEqual(g.rules, [...c.rules].sort());
          } else {
            assert.equal(g.status, 0, JSON.stringify(g.out));
          }
        } else {
          assert.equal(satisfiesRequire(rule, recs), c.expect === 'pass');
          // The canned file is guardrail-valid either way; the rule is about content, not legality.
          assert.equal(g.status, 0, JSON.stringify(g.out));
        }
      });
    }
  }
}

test('every rule kind has a passing and a deliberately violating canned file', () => {
  const seen = {};
  for (const name of FIXTURES) {
    for (const r of json(path.join(goldenDir, `${name}.json`)).rules) {
      for (const c of r.cases) (seen[r.kind] ??= new Set()).add(c.expect);
    }
  }
  assert.deepEqual([...seen.guardrail].sort(), ['fail', 'pass']);
  assert.deepEqual([...seen['must-not-recommend']].sort(), ['pass', 'violate']);
  assert.deepEqual([...seen['must-recommend']].sort(), ['fail', 'pass']);
});

test('the canned cases exercise R1, R2, R3, R4, R5, R6 and R7', () => {
  const fired = new Set();
  for (const name of FIXTURES) for (const r of json(path.join(goldenDir, `${name}.json`)).rules) for (const c of r.cases) for (const x of c.rules ?? []) fired.add(x);
  assert.deepEqual([...fired].sort(), ['R1-hop', 'R2-prereq', 'R3-order', 'R4-unknown-id', 'R5-shape', 'R6-anchor', 'R7-rejected']);
});

test('every canned recs file is referenced by a golden rule, and at least three fixtures have recs', () => {
  const referenced = new Set();
  for (const name of FIXTURES) for (const r of json(path.join(goldenDir, `${name}.json`)).rules) for (const c of r.cases) referenced.add(c.recs);
  const files = fs.readdirSync(path.join(goldenDir, 'recs')).filter((f) => f.endsWith('.json')).map((f) => `recs/${f}`).sort();
  assert.deepEqual([...referenced].sort(), files);
  assert.ok(new Set(files.map((f) => f.split('/')[1].split('.')[0])).size >= 3);
});

test('the legacy Java+MVP fixture must not receive an unjustified jump to Compose and MVI (guardrail catches it)', () => {
  const golden = json(path.join(goldenDir, 'legacy-java-mvp.json'));
  const rule = golden.rules.find((r) => r.kind === 'must-not-recommend');
  assert.ok(rule, 'rule present');
  assert.deepEqual(rule.forbid, [{ dimension: 'ui', to: ['compose'] }, { dimension: 'presentation', to: ['udf-stateflow', 'circuit-decompose'] }]);
  const violating = rule.cases.find((c) => c.expect === 'violate');
  const recsFile = path.join(goldenDir, violating.recs);
  assert.ok(violatesForbid(rule, json(recsFile)));
  const dir = fileURLToPath(new URL('../fixtures/legacy-java-mvp', import.meta.url));
  const g = guardrail(analyse('legacy-java-mvp', dir).profileFile, recsFile);
  assert.equal(g.status, 1);
  assert.ok(g.rules.includes('R1-hop'));
});

// ---- Part 2: pinned real apps ----
const apps = json(path.join(here, 'apps.json'));

test('apps.json validates against the documented schema', () => {
  assert.deepEqual(validateApps(apps), []);
  assert.deepEqual(Object.keys(apps).sort(), ['apps', 'schemaVersion']);
});

test('apps.json validator rejects each kind of bad input', () => {
  const good = { id: 'nia', era: 'modern-compose', repo: 'https://example.invalid/org/app', commit: 'a'.repeat(40), license: 'Apache-2.0', notes: '' };
  const with_ = (o) => ({ schemaVersion: 1, apps: [{ ...good, ...o }] });
  assert.deepEqual(validateApps(with_({})), []);
  assert.deepEqual(validateApps({ schemaVersion: 1, apps: [] }), []);
  const bad = [
    [{ schemaVersion: 2, apps: [] }, /schemaVersion/],
    [{ schemaVersion: 1 }, /apps must be an array/],
    [null, /must be an object/],
    [with_({ id: 'Bad_Id' }), /id must match/],
    [with_({ id: '../x' }), /id must match/],
    [with_({ id: '' }), /id must match/],
    [with_({ era: 'future' }), /era must be one of/],
    [with_({ repo: 'http://example.invalid/a' }), /https/],
    [with_({ repo: 'git@example.invalid:a/b.git' }), /valid URL/],
    [with_({ repo: 'file:///tmp/x' }), /https/],
    [with_({ repo: 'https:host.example/a' }), /normalized/],
    [with_({ repo: 'https:/host.example/a' }), /normalized/],
    [with_({ repo: 'https://host.example/a\n' }), /whitespace or control/],
    [with_({ repo: 'https://host.example/a b' }), /whitespace or control/],
    [with_({ repo: 'https://host.example/a\u0000' }), /whitespace or control/],
    [with_({ repo: 'https://host.example:8443/a' }), /default https port/],
    [with_({ repo: 'https://host.example:443/a' }), /normalized/],
    [with_({ repo: 'https://host.example/a/../b' }), /normalized/],
    [with_({ repo: 'https://HOST.example/a' }), /normalized/],
    [with_({ repo: 'https://127.0.0.1/a' }), /IP literal/],
    [with_({ repo: 'https://0x7f.1/a' }), /normalized/],
    [with_({ repo: 'https://[::1]/a' }), /IP literal/],
    [with_({ repo: 'https://localhost/a' }), /dotted DNS/],
    [with_({ repo: 'https://app.localhost/a' }), /dotted DNS/],
    [with_({ repo: 'https://intranet/a' }), /dotted DNS/],
    [with_({ repo: 'https://host.example/a?x=1' }), /query or fragment/],
    [with_({ repo: 'https://host.example/a#f' }), /query or fragment/],
    [with_({ repo: 'https://user:pw@example.invalid/a' }), /credentials/],
    [with_({ commit: 'A'.repeat(40) }), /40 lowercase hex/],
    [with_({ commit: 'abc123' }), /40 lowercase hex/],
    [with_({ commit: 'a'.repeat(41) }), /40 lowercase hex/],
    [with_({ commit: 'main' }), /40 lowercase hex/],
    [with_({ license: '' }), /license/],
    [with_({ license: '   ' }), /license/],
    [with_({ license: undefined }), /license/],
    [with_({ notes: 5 }), /notes/],
    [with_({ extra: 1 }), /unknown key/],
    [{ schemaVersion: 1, apps: [good, good] }, /duplicate id/],
    [{ schemaVersion: 1, apps: ['x'] }, /must be an object/],
  ];
  for (const [input, re] of bad) assert.match(validateApps(input).join('\n'), re, JSON.stringify(input));
  assert.deepEqual(ERAS, ['legacy-java-mvp', 'mvvm-rxjava', 'modern-compose']);
});

test('the allowlist strip removes everything the scan does not read (synthetic tree)', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'strip-'));
  const put = (rel, content = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), content); };
  for (const rel of ['build.gradle', 'settings.gradle.kts', 'gradle.properties', 'gradle/libs.versions.toml', 'app/src/main/A.kt', 'app/src/main/B.java',
    'app/src/main/AndroidManifest.xml', 'app/proguard-rules.pro', 'README.md', 'LICENSE', '.gitignore', 'config/detekt.yml', 'test/Keep.kt']) put(rel);
  for (const rel of ['run.js', 'a.mjs', 'b.cjs', 'c.ts', 'd.mts', 'e.cts', 'f.jsx', 'g.tsx', 'x.test.ts', 'app/y.test.js', 'test/z.js', 'test/deep/w.mjs',
    '.github/workflows/ci.yml.sh', 'gradlew', 'gradlew.bat', 'bin/tool', 'logo.png', 'lib.jar', '.gitmodules', 'node_modules/p/index.js']) put(rel);
  put('script', '#!/usr/bin/env node\nconsole.log(1)\n');
  fs.symlinkSync('run.js', path.join(dir, 'link.js'));
  fs.symlinkSync('build.gradle', path.join(dir, 'link.gradle'));
  fs.symlinkSync('test', path.join(dir, 'dirlink'));
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/x\n');
  assert.ok(findNodeDiscoverable(dir).length >= 9, 'detective check sees the planted files');
  stripToAllowlist(dir);
  const left = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else left.push(r); } };
  walk(dir, '');
  assert.deepEqual(left.sort(), ['.git/HEAD', '.gitignore', 'LICENSE', 'README.md', 'app/proguard-rules.pro', 'app/src/main/A.kt', 'app/src/main/AndroidManifest.xml', 'app/src/main/B.java',
    'build.gradle', 'config/detekt.yml', 'gradle.properties', 'gradle/libs.versions.toml', 'settings.gradle.kts', 'test/Keep.kt']);
  assert.equal(fs.existsSync(path.join(dir, '.git', 'hooks')), false);
  assert.equal(fs.lstatSync(dir).isDirectory(), true);
  assert.deepEqual(findNodeDiscoverable(dir), []);
});

test('the detective check flags every node-discoverable extension', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'detect-'));
  const exts = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'];
  for (const e of exts) fs.writeFileSync(path.join(dir, `f.${e}`), '');
  assert.deepEqual(findNodeDiscoverable(dir), exts.map((e) => `f.${e}`).sort());
});

for (const app of validateApps(apps).length === 0 ? apps.apps : []) {
  const dir = path.join(here, 'apps', app.id);
  test(`real app ${app.id}: golden profile`, (t) => {
    if (!fs.existsSync(dir)) {
      t.skip(`apps/${app.id} not fetched; run node dev/fetch-eval-apps.mjs to enable`);
      return;
    }
    // Detective control: node's test discovery runs any js/ts file under test/. The preventive control is the allowlist strip.
    assert.deepEqual(findNodeDiscoverable(dir), [], `apps/${app.id} holds files that node --test would execute; re-run dev/fetch-eval-apps.mjs`);
    const golden = json(path.join(goldenDir, 'apps', `${app.id}.json`));
    assert.equal(golden.fixture, app.id);
    const a = analyse(`app-${app.id}`, dir);
    assert.deepEqual(projectProfile(a.profile), golden.profile);
    assert.deepEqual(projectCandidates(a.candidates), golden.candidates);
  });
}
