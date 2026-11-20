import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog, loadScoring } from '../skill/scripts/lib/catalog.js';
import { detectStack } from '../skill/scripts/lib/detect.js';
import { buildFeatureMap } from '../skill/scripts/lib/features.js';
import { churnByPath } from '../skill/scripts/lib/git.js';
import { renderKnowledge, generatedHeader } from '../skill/scripts/lib/knowledge.js';
import { discoverModules } from '../skill/scripts/lib/modules.js';
import { listFiles } from '../skill/scripts/lib/walk.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = (n) => path.join(root, 'test/fixtures', n);
const cli = path.join(root, 'skill/scripts/features.js');
const catalog = loadCatalog();
const scoring = loadScoring();
const tmps = [];
const tmp = (p = 'aa-feat-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  tmps.push(d);
  return d;
};
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
const map = (dir, opts = {}) => buildFeatureMap(dir, { profile: detectStack(dir, catalog), scoring, churn: null, ...opts });
const by = (m, name) => m.features.find((f) => f.name === name);

test('feature-app: modules, buckets, risk and reasons', () => {
  const m = map(fx('feature-app'));
  assert.equal(m.fallback, 'none');
  assert.equal(m.churnAvailable, false);
  assert.deepEqual(m.features.map((f) => f.name).sort(), ['legacy-reports', 'login', 'payment', 'profile']);
  for (const n of ['login', 'payment']) {
    assert.equal(by(m, n).risk, 'high', n);
    assert.notEqual(by(m, n).bucket, 'first', n);
    assert.deepEqual(by(m, n).riskMatched, [n]);
  }
  assert.equal(by(m, 'profile').bucket, 'first');
  assert.equal(by(m, 'profile').risk, 'medium');
  assert.ok(by(m, 'profile').testFiles >= 1);
  assert.equal(by(m, 'profile').proximity, 0.5);
  const lr = by(m, 'legacy-reports');
  assert.equal(lr.bucket, 'last');
  assert.equal(lr.testFiles, 0);
  assert.ok(lr.reasons.some((r) => r.includes('no tests')));
  assert.ok(lr.loc > scoring.sizeBands.largeLoc);
  assert.equal(by(m, 'login').fanOut, 1);
  assert.equal(by(m, 'payment').fanIn, 1);
  assert.equal(by(m, 'login').kind, 'module');
  for (const f of m.features) assert.ok(f.score >= 0 && f.score <= 100, f.name);
});

test('a high-risk feature that would score first is capped to next with a reason', () => {
  const tuned = structuredClone(scoring);
  tuned.buckets = { first: 1, next: 0.5 };
  const m = map(fx('feature-app'), { scoring: tuned });
  const login = by(m, 'login');
  assert.equal(login.bucket, 'next');
  assert.ok(login.reasons.some((r) => r.startsWith('capped to next')));
  assert.equal(by(m, 'profile').bucket, 'first');
});

test('scores are deterministic', () => {
  assert.deepEqual(map(fx('feature-app')), map(fx('feature-app')));
});

test('a weights override changes bucket results', () => {
  const dir = tmp('aa-scoring-');
  const tuned = structuredClone(scoring);
  tuned.weights = { isolation: 0, size: 0, tests: 0, churn: 0, risk: 0, proximity: 1 };
  fs.writeFileSync(path.join(dir, 'scoring.json'), JSON.stringify(tuned));
  const m = map(fx('feature-app'), { scoring: loadScoring(dir) });
  assert.equal(by(m, 'login').score, 100 * by(m, 'login').proximity);
  assert.equal(by(m, 'login').bucket, 'next'); // proximity 1 would be first, capped by risk
  assert.notEqual(by(m, 'profile').bucket, 'first');
  assert.notEqual(JSON.stringify(m.features.map((f) => [f.name, f.bucket])), JSON.stringify(map(fx('feature-app')).features.map((f) => [f.name, f.bucket])));
});

test('churn from git history, and null without it', () => {
  const dir = path.join(tmp(), 'app');
  fs.cpSync(fx('feature-app'), dir, { recursive: true });
  const none = map(dir);
  assert.equal(none.churnAvailable, false);
  assert.equal(churnByPath(dir), null); // not a repo
  git(dir, 'init');
  assert.equal(churnByPath(dir), null); // no commits
  assert.equal(map(dir, { churn: churnByPath(dir) }).features.length, 4);
  // Only the touched files are tracked, so each commit adds exactly one change to one feature file.
  const touch = (rel, i) => {
    fs.appendFileSync(path.join(dir, rel), `// change ${i}\n`);
    git(dir, 'add', rel);
    git(dir, 'commit', '-m', `c${i}`);
  };
  const profileFile = 'feature/profile/src/main/kotlin/com/example/featureapp/feature/profile/ProfileScreen.kt';
  for (let i = 1; i <= 5; i++) touch(profileFile, i);
  touch('feature/legacy-reports/src/main/kotlin/com/example/featureapp/feature/reports/ReportsActivity.kt', 1);
  const churn = churnByPath(dir);
  assert.equal(churn[profileFile], 5);
  const m = map(dir, { churn });
  assert.equal(m.churnAvailable, true);
  assert.equal(by(m, 'profile').churn, 5);
  assert.equal(by(m, 'legacy-reports').churn, 1);
  assert.equal(by(m, 'login').churn, 0);
});

test('churn is null (not a throw) for a shallow clone with one commit', () => {
  const src = path.join(tmp(), 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'a.txt'), 'a');
  git(src, 'init');
  git(src, 'add', '.');
  git(src, 'commit', '-m', 'one');
  fs.writeFileSync(path.join(src, 'a.txt'), 'b');
  git(src, 'commit', '-am', 'two');
  const clone = path.join(tmp(), 'clone');
  execFileSync('git', ['clone', '--depth', '1', '--quiet', 'file://' + src, clone], { stdio: 'ignore' });
  assert.equal(churnByPath(clone), null);
  assert.deepEqual(churnByPath(src), { 'a.txt': 2 });
});

test('legacy-java-mvp has no feature structure: fallback, never empty', () => {
  const m = map(fx('legacy-java-mvp'));
  assert.ok(['packages', 'app'].includes(m.fallback));
  assert.ok(m.features.length > 0);
  assert.ok(m.features.every((f) => ['first', 'next', 'last'].includes(f.bucket)));
});

test('top-level packages fall back when there are no feature units', () => {
  const dir = tmp('aa-pkgs-');
  fs.writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":app")\n');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app/build.gradle.kts'), 'plugins { id("com.android.application") }\n');
  const base = path.join(dir, 'app/src/main/kotlin/com/x');
  for (const pkg of ['ui', 'data']) {
    fs.mkdirSync(path.join(base, pkg), { recursive: true });
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(base, pkg, `F${i}.kt`), `package com.x.${pkg}\n\nclass F${i}\n`);
  }
  const m = map(dir);
  assert.equal(m.fallback, 'packages');
  assert.deepEqual(m.features.map((f) => f.name).sort(), ['data', 'ui']);
  assert.ok(m.features.every((f) => f.kind === 'package'));
});

test('feature(s)/<name> packages are units with fan-in and fan-out from imports', () => {
  const dir = tmp('aa-pkgfeat-');
  fs.writeFileSync(path.join(dir, 'settings.gradle.kts'), 'include(":app")\n');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app/build.gradle.kts'), 'plugins { id("com.android.application") }\n');
  const base = path.join(dir, 'app/src/main/kotlin/com/x/features');
  for (const n of ['cart', 'search']) fs.mkdirSync(path.join(base, n), { recursive: true });
  fs.writeFileSync(path.join(base, 'cart/Cart.kt'), 'package com.x.features.cart\n\nimport com.x.features.search.Query\n\nclass Cart\n');
  fs.writeFileSync(path.join(base, 'search/Query.kt'), 'package com.x.features.search\n\nclass Query\n');
  const m = map(dir);
  assert.equal(m.fallback, 'none');
  assert.deepEqual(m.features.map((f) => [f.name, f.kind, f.fanIn, f.fanOut]).sort(), [
    ['cart', 'package', 0, 1],
    ['search', 'package', 1, 0],
  ]);
});

test('feature-map.md lists every feature with its bucket', () => {
  const dir = fx('feature-app');
  const profile = detectStack(dir, catalog);
  const modules = discoverModules(dir, listFiles(dir, { gitignore: true }));
  const meta = { date: '2026-11-20', commit: 'abc1234', catalogVersion: catalog.catalogVersion };
  const m = map(dir);
  const md = renderKnowledge(profile, modules, catalog, meta, m)['knowledge/feature-map.md'];
  assert.ok(md.startsWith(generatedHeader(meta) + '\n\n'));
  assert.ok(!md.includes('TODO'));
  for (const f of m.features) {
    const section = md.split('## ').find((s) => s.startsWith(f.bucket === 'first' ? 'First' : f.bucket === 'next' ? 'Next' : 'Last'));
    assert.ok(section.includes(`| ${f.name} |`), `${f.name} in ${f.bucket}`);
  }
});

test('loadScoring validates strictly with file-prefixed errors', () => {
  const bad = (mutate, re) => {
    const dir = tmp('aa-scoring-');
    const s = structuredClone(scoring);
    mutate(s);
    fs.writeFileSync(path.join(dir, 'scoring.json'), JSON.stringify(s));
    assert.throws(() => loadScoring(dir), re);
  };
  bad((s) => (s.weights.risk = 0.5), /^Error: scoring\.json: weights must sum to 1/);
  bad((s) => (s.weights.size = -0.1), /scoring\.json: weights\.size/);
  bad((s) => (s.buckets = { first: 40, next: 40 }), /scoring\.json: buckets\.first must be greater/);
  bad((s) => (s.riskKeywords.high = [1]), /scoring\.json: riskKeywords\.high/);
  bad((s) => (s.riskKeywords.medium = ['x'.repeat(41)]), /scoring\.json: riskKeywords\.medium/);
  assert.throws(() => loadScoring(tmp('aa-empty-')), /^Error: scoring\.json:/);
});

test('CLI: exit 0 on feature-app, json and md, exit 2 on a plain dir, 1 on usage', () => {
  const out = JSON.parse(execFileSync(process.execPath, [cli, fx('feature-app')], { encoding: 'utf8' }));
  assert.equal(out.fallback, 'none');
  assert.equal(out.features.length, 4);
  const md = execFileSync(process.execPath, [cli, fx('feature-app'), '--format', 'md'], { encoding: 'utf8' });
  assert.match(md, /# Feature map/);
  const dir = tmp('aa-plain-');
  const outFile = path.join(tmp('aa-out-'), 'f.md');
  execFileSync(process.execPath, [cli, fx('feature-app'), '--format', 'md', '--out', outFile]);
  assert.match(fs.readFileSync(outFile, 'utf8'), /profile/);
  const run = (...args) => {
    try {
      execFileSync(process.execPath, [cli, ...args], { stdio: 'pipe' });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  assert.equal(run(dir), 2);
  assert.equal(run(), 1);
  assert.equal(run(fx('feature-app'), '--format', 'xml'), 1);
});
