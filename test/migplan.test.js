import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog, loadScoring } from '../skill/scripts/lib/catalog.js';
import { detectStack } from '../skill/scripts/lib/detect.js';
import { buildFeatureMap } from '../skill/scripts/lib/features.js';
import { detectReuse } from '../skill/scripts/lib/reuse.js';
import { loadPlaybooks, playbooksDir } from '../skill/scripts/lib/playbooks.js';
import { checkRecommendations } from '../skill/scripts/lib/guardrail.js';
import { buildPlan, checkPlan, renderRoadmap, EXPAND_DIMENSIONS } from '../skill/scripts/lib/migplan.js';
import { safeOutPath, writeOut } from '../skill/scripts/lib/outpath.js';
import { scanInstructions } from '../skill/scripts/lib/injection.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = (n) => path.join(root, 'test/fixtures', n);
const cli = path.join(root, 'skill/scripts/migration-plan.js');
const catalog = loadCatalog();
const playbooks = loadPlaybooks(fileURLToPath(playbooksDir));
const tmps = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-plan-'));
  tmps.push(d);
  return d;
};
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const profileOf = (dir) => detectStack(dir, catalog);
const featuresOf = (dir, profile) => buildFeatureMap(dir, { profile, scoring: loadScoring(), churn: null });
const step = (id, dimension, from, to, extra = {}) => ({ id, dimension, from, to, dependsOn: [], ...extra });
const recsOf = (steps, dimensions = []) => ({ schemaVersion: 1, catalogVersion: catalog.catalogVersion, generatedAt: '2026-11-20', dimensions, steps });
const plan = (dir, steps, reuseOver = {}, dimensions = []) => {
  const profile = profileOf(dir);
  const reuse = { ...detectReuse(dir), ...reuseOver };
  return buildPlan({ recs: recsOf(steps, dimensions), features: featuresOf(dir, profile), reuse, playbooks, profile, catalog });
};

const FA = fx('feature-app');
const feats = featuresOf(FA, profileOf(FA)).features;
const bucketOf = (n) => feats.find((f) => f.name === n)?.bucket;

test('fixture buckets are as the plan expects', () => {
  assert.ok(feats.some((f) => f.bucket === 'first'));
  assert.ok(feats.some((f) => f.bucket === 'last'));
});

test('safety nets for first features; migration steps depend on them; high risk gets decision', () => {
  const p = plan(FA, [step('ui1', 'ui', 'xml-layouts', 'compose')]);
  assert.deepEqual(checkPlan(p), []);
  for (const f of feats.filter((x) => x.bucket !== 'last')) {
    const sn = p.steps.find((s) => s.id === `safety-net:${f.id.toLowerCase()}`);
    assert.ok(sn, f.id);
    assert.equal(sn.track, 'enabling');
    assert.ok(sn.verification.some((v) => v.includes('./gradlew testDebugUnitTest')));
    const mig = p.steps.filter((s) => s.track === 'feature' && s.feature === f.id);
    assert.ok(mig.length > 0);
    for (const m of mig) assert.ok(m.dependsOn.includes(sn.id));
  }
  for (const s of p.steps.filter((x) => x.track === 'feature')) {
    const f = feats.find((x) => x.id === s.feature);
    if (f.risk === 'high') assert.ok(s.tags.includes('decision'), s.id);
  }
  assert.notEqual(bucketOf('login'), 'last');
  const login = p.steps.filter((s) => s.track === 'feature' && s.feature === 'login');
  assert.ok(login.length > 0);
  for (const s of login) assert.ok(s.tags.includes('decision') && s.dependsOn.includes('safety-net:login'));
});

test('last features have no steps and a leave-as-is note', () => {
  const p = plan(FA, [step('ui1', 'ui', 'xml-layouts', 'compose')]);
  for (const f of feats.filter((x) => x.bucket === 'last')) {
    assert.ok(!p.steps.some((s) => s.feature === f.id));
    assert.ok(p.notes.includes(`leave as is: ${f.name}`), f.name);
  }
});

test('persistence recommendation with playbook is exactly one data step', () => {
  const p = plan(FA, [step('p1', 'persistence', 'sqliteopenhelper', 'room')]);
  const data = p.steps.filter((s) => s.track === 'data');
  assert.equal(data.length, 1);
  assert.equal(data[0].playbook, 'sqliteopenhelper--to--room');
  assert.ok(data[0].tags.includes('irreversible') && data[0].tags.includes('decision'));
  assert.deepEqual(p.tracks.data, [data[0].id]);
  assert.ok(!p.tracks.features.includes(data[0].id));
  assert.ok(data[0].evidence.some((e) => e.includes('playbook: sqliteopenhelper--to--room (verified: false)')));
});

test('no matching playbook: plain step with a note; source tags kept', () => {
  const p = plan(FA, [step('p1', 'language', 'java', 'java8-desugar', { tags: ['decision'] })]);
  const s = p.steps.find((x) => x.id === 'p1');
  assert.ok(s);
  assert.ok(s.tags.includes('decision'));
  assert.equal(s.playbook, undefined);
  assert.ok(p.notes.some((n) => n.includes('no playbook')));
});

test('duplication: extract:design-system precedes UI feature steps', () => {
  const p = plan(FA, [step('ui1', 'ui', 'xml-layouts', 'compose')], { duplicationScore: 'high' });
  const idx = p.steps.findIndex((s) => s.id === 'extract:design-system');
  assert.ok(idx >= 0);
  const ui = p.steps.filter((s) => s.dimension === 'ui' && s.track === 'feature');
  assert.ok(ui.length > 0);
  for (const s of ui) {
    assert.ok(s.dependsOn.includes('extract:design-system'));
    assert.ok(p.steps.indexOf(s) > idx);
  }
  const none = plan(FA, [step('ui1', 'ui', 'xml-layouts', 'compose')], { duplicationScore: 'low' });
  assert.ok(!none.steps.some((s) => s.id === 'extract:design-system'));
  const dataOnly = plan(FA, [step('p1', 'persistence', 'sqliteopenhelper', 'room')], { duplicationScore: 'high' });
  assert.ok(!dataOnly.steps.some((s) => s.id === 'extract:design-system'));
});

test('ids sanitized, expansions depend on same-feature prerequisites, deterministic and acyclic', () => {
  const steps = [
    step('s1', 'ui', 'xml-layouts', 'compose'),
    step('s2', 'navigation', 'jetpack-nav-xml', 'nav-compose-typesafe', { dependsOn: ['s1'] }),
    step('s3', 'async', 'rxjava3', 'coroutines-flow'),
    step('s4', 'persistence', 'sqliteopenhelper', 'room', { dependsOn: ['s2'] }),
  ];
  for (const dir of [FA, fx('reuse-app'), fx('legacy-java-mvp'), fx('modern-compose')]) {
    const a = plan(dir, steps, { duplicationScore: 'medium' });
    const b = plan(dir, steps, { duplicationScore: 'medium' });
    assert.deepEqual(a, b);
    assert.deepEqual(checkPlan(a), []);
    for (const s of a.steps) assert.match(s.id, /^[a-z0-9:_.-]+$/);
  }
  const p = plan(FA, steps);
  for (const s of p.steps.filter((x) => x.id.startsWith('s2:'))) {
    assert.ok(s.dependsOn.includes(`s1:${s.feature.toLowerCase()}`));
    assert.equal(s.dependsOn.filter((d) => d.startsWith('s1:')).length, 1);
  }
  const data = p.steps.find((x) => x.id === 's4');
  assert.ok(data.dependsOn.length >= 1 && data.dependsOn.every((d) => d.startsWith('s2:')));
});

test('checkPlan detects cycles, missing deps and bad ids', () => {
  const p = plan(FA, [step('ui1', 'ui', 'xml-layouts', 'compose')]);
  const bad = structuredClone(p);
  bad.steps[0].dependsOn = ['nope'];
  assert.ok(checkPlan(bad).some((m) => m.includes('nope')));
  const cyc = structuredClone(p);
  const [a, b] = cyc.steps;
  a.dependsOn = [b.id];
  b.dependsOn = [a.id];
  assert.ok(checkPlan(cyc).some((m) => m.includes('cycle')));
  const bid = structuredClone(p);
  bid.steps[0].id = 'Bad Id';
  assert.ok(checkPlan(bid).length > 0);
});

test('hostile feature names cannot forge Markdown rows or headings', () => {
  const profile = profileOf(FA);
  const features = { features: [{ id: 'x|\n# H', name: 'x|\n# H', bucket: 'first', score: 80, risk: 'low', paths: ['a|b\n# forged'] }] };
  const p = buildPlan({ recs: recsOf([step('ui1', 'ui', 'xml-layouts', 'compose')]), features, reuse: { duplicationScore: 'low' }, playbooks, profile, catalog });
  assert.deepEqual(checkPlan(p), []);
  const md = renderRoadmap(p);
  for (const line of md.split('\n').filter(Boolean)) assert.ok(line.startsWith('|'), line);
  assert.equal(md.split('\n').filter(Boolean).length, p.steps.length + 2);
});

test('transitive hop gets no playbook and a note', () => {
  const profile = profileOf(FA);
  const p = buildPlan({
    recs: recsOf([step('p1', 'persistence', 'sqliteopenhelper', 'room', { justification: 'x'.repeat(30) })]),
    features: featuresOf(FA, profile), reuse: { duplicationScore: 'low' }, playbooks: [], profile, catalog,
  });
  assert.equal(p.steps.find((s) => s.id === 'p1').playbook, undefined);
});

test('later/dont dimensions become notes', () => {
  const p = plan(FA, [], {}, [{ dimension: 'di', current: [], target: 'hilt', label: 'later', rationale: 'wait for the next quarter' }]);
  assert.ok(p.notes.some((n) => n.startsWith('later: di')));
});

test('renderRoadmap: header, one row per step, all todo, tags shown', () => {
  const p = plan(FA, [step('p1', 'persistence', 'sqliteopenhelper', 'room')]);
  const md = renderRoadmap(p);
  assert.ok(md.startsWith('| Step | Description | Status |\n| --- | --- | --- |\n'));
  const rows = md.split('\n\n')[0].trim().split('\n').slice(2);
  assert.equal(rows.length, p.steps.length);
  for (const r of rows) assert.ok(r.endsWith('| todo |'));
  assert.ok(md.includes('[irreversible]') && md.includes('[decision]'));
  assert.deepEqual(scanInstructions(md), []);
});

test('expansion set is documented', () => {
  const doc = fs.readFileSync(path.join(root, 'skill/references/migration-patterns.md'), 'utf8');
  for (const d of EXPAND_DIMENSIONS) assert.ok(doc.includes(`\`${d}\``), d);
});

test('references scan clean', () => {
  for (const f of ['migration-patterns', 'feature-prioritization', 'modularization']) {
    const t = fs.readFileSync(path.join(root, `skill/references/${f}.md`), 'utf8');
    assert.deepEqual(scanInstructions(t), [], f);
  }
  const t = fs.readFileSync(path.join(root, 'skill/templates/ai/migration/roadmap.md'), 'utf8');
  assert.deepEqual(scanInstructions(t), []);
  assert.ok(t.includes('TODO: run "setup" in your agent'));
});

// ---- CLI
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const writeRecs = (steps, dimensions) => {
  const f = path.join(tmp(), 'recs.json');
  fs.writeFileSync(f, JSON.stringify(recsOf(steps, dimensions)));
  return f;
};

test('CLI: valid recs produce a plan (json and md), nothing written into the project', () => {
  const recs = writeRecs([step('ui1', 'ui', 'xml-layouts', 'compose')]);
  const r = run([FA, '--recs', recs]);
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(p.schemaVersion, 1);
  assert.deepEqual(checkPlan(p), []);
  const m = run([FA, '--recs', recs, '--format', 'md']);
  assert.equal(m.status, 0);
  assert.ok(m.stdout.startsWith('| Step | Description | Status |'));
  assert.ok(!fs.existsSync(path.join(FA, '.ai')));
});

test('CLI: invalid recs exit 1 with violations, no plan', () => {
  const recs = writeRecs([step('x', 'ui', 'compose', 'xml-layouts')]);
  const r = run([FA, '--recs', recs]);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.ok(out.violations.length > 0);
  assert.equal(out.steps, undefined);
});

test('CLI: exit codes for usage, non-gradle dir, unreadable recs, --out inside project', () => {
  assert.equal(run([]).status, 1);
  assert.equal(run([FA]).status, 1);
  assert.equal(run([FA, '--recs', writeRecs([]), '--bogus']).status, 1);
  assert.equal(run([tmp(), '--recs', writeRecs([])]).status, 2);
  assert.equal(run([FA, '--recs', '/nonexistent/recs.json']).status, 2);
  assert.equal(run([FA, '--recs', writeRecs([]), '--out', path.join(FA, 'plan.json')]).status, 1);
  assert.ok(!fs.existsSync(path.join(FA, 'plan.json')));
  const out = path.join(tmp(), 'plan.json');
  assert.equal(run([FA, '--recs', writeRecs([]), '--out', out]).status, 0);
  assert.ok(fs.existsSync(out));
});

// ---- fix round 1
const synthetic = (n, bucketOfI = (i) => (i % 3 === 0 ? 'first' : i % 3 === 1 ? 'next' : 'last')) => ({
  features: Array.from({ length: n }, (_, i) => ({ id: `feat-${i}`, name: `feat-${i}`, bucket: bucketOfI(i), score: 50 + (i % 40), risk: i % 7 === 0 ? 'high' : 'low', paths: [`m/f${i}`] })),
});

test('2000 features: warning notes survive, leave-as-is is one summary line, plan bounded and acyclic', () => {
  const profile = profileOf(FA);
  const recs = recsOf([
    step('s1', 'ui', 'xml-layouts', 'compose'),
    step('s2', 'language', 'java', 'java8-desugar'),
    step('s3', 'persistence', 'sqliteopenhelper', 'room', { dependsOn: ['s1'], tags: ['decision'] }),
  ], [{ dimension: 'di', current: [], target: 'hilt', label: 'later', rationale: 'later please' }]);
  const t0 = Date.now();
  const p = buildPlan({ recs, features: synthetic(2000), reuse: { duplicationScore: 'high' }, playbooks, profile, catalog });
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(checkPlan(p), []);
  assert.ok(p.notes.some((n) => n.startsWith('no playbook')));
  assert.ok(p.notes.some((n) => n.startsWith('later: di')));
  assert.equal(p.notes.filter((n) => n.startsWith('leave as is')).length, 11);
  assert.ok(p.notes.some((n) => /^leave as is: and \d+ more features$/.test(n)));
  assert.ok(p.notes.some((n) => n.includes('more features not planned')));
  const again = buildPlan({ recs, features: synthetic(2000), reuse: { duplicationScore: 'high' }, playbooks, profile, catalog });
  assert.deepEqual(p, again);
  const data = p.steps.find((s) => s.id === 's3');
  assert.ok(data.tags.includes('decision') && data.tags.includes('irreversible'));
  const expanded = p.steps.filter((s) => s.id.startsWith('s1:'));
  assert.equal(expanded.length, 40);
  for (const s of expanded) assert.ok(s.dependsOn.includes(`safety-net:${s.feature}`));
});

test('tag union on expansion: source tags kept on every feature step', () => {
  const p = plan(FA, [step('u', 'ui', 'xml-layouts', 'compose', { tags: ['irreversible'] })]);
  const ex = p.steps.filter((s) => s.id.startsWith('u:'));
  assert.ok(ex.length > 1);
  for (const s of ex) assert.ok(s.tags.includes('irreversible'));
});

test('renderRoadmap lists notes and marks steps without a playbook', () => {
  const p = plan(FA, [step('p1', 'language', 'java', 'java8-desugar')]);
  const md = renderRoadmap(p);
  assert.ok(md.includes('[no playbook]'));
  assert.ok(md.includes('\n## Notes\n'));
  const hostile = { ...p, notes: ['x\n# forged'] };
  assert.ok(!renderRoadmap(hostile).split('\n').some((l) => l.startsWith('# forged')));
});

test('ids never become redaction markers', async () => {
  const { renameUnsafeIds } = await import('../skill/scripts/lib/migplan.js');
  const { redact } = await import('../skill/scripts/lib/redact.js');
  const profile = profileOf(FA);
  const secret = `ghp_${'a1B2'.repeat(9)}`;
  const features = { features: [{ id: secret, name: secret, bucket: 'first', score: 80, risk: 'low', paths: [] }] };
  const p = buildPlan({ recs: recsOf([step('u', 'ui', 'xml-layouts', 'compose')]), features, reuse: {}, playbooks, profile, catalog });
  const r = renameUnsafeIds(p, (s) => redact(s).text);
  for (const s of r.steps) assert.equal(redact(s.id).text, s.id);
  assert.deepEqual(checkPlan(r), []);
});

test('CLI: ADR rejection refuses with a violation', () => {
  const adr = tmp();
  fs.writeFileSync(path.join(adr, '0001-no-compose.md'), '---\nid: "0001"\ntitle: No Compose\nstatus: rejected\ndate: 2026-11-19\ndimension: ui\ntarget: compose\nreopenIf:\nreason: "We stay on views for now."\n---\n\nbody\n');
  const recs = writeRecs([step('ui1', 'ui', 'xml-layouts', 'compose')]);
  const r = run([FA, '--recs', recs, '--adr-dir', adr]);
  assert.equal(r.status, 1);
  assert.ok(JSON.parse(r.stdout).violations.some((v) => v.rule === 'R7-rejected'));
});

// ---- --out guard
const mkout = () => {
  const outside = tmp();
  const proj = tmp();
  fs.writeFileSync(path.join(proj, 'target.txt'), 'keep');
  return { outside, proj };
};

test('safeOutPath: links, directories, hardlinks, inside-project and normal paths', () => {
  const { outside, proj } = mkout();
  fs.symlinkSync(path.join(proj, 'target.txt'), path.join(outside, 'link.json'));
  assert.throws(() => safeOutPath(path.join(outside, 'link.json'), proj), /symbolic link/);
  fs.symlinkSync(proj, path.join(outside, 'dirlink'));
  assert.throws(() => safeOutPath(path.join(outside, 'dirlink', 'x.json'), proj), /outside the project/);
  fs.linkSync(path.join(proj, 'target.txt'), path.join(outside, 'hard.json'));
  assert.throws(() => safeOutPath(path.join(outside, 'hard.json'), proj), /hard-linked/);
  fs.mkdirSync(path.join(outside, 'adir'));
  assert.throws(() => safeOutPath(path.join(outside, 'adir'), proj), /directory/);
  assert.throws(() => safeOutPath(path.join(proj, 'new.json'), proj), /outside the project/);
  assert.equal(safeOutPath(path.join(proj, 'new.json'), proj, { allowInside: true }), path.join(proj, 'new.json'));
  assert.throws(() => safeOutPath(path.join(outside, 'nodir', 'x.json'), proj), /does not exist/);
  const ok = safeOutPath(path.join(outside, 'plan.json'), proj);
  writeOut(ok, 'one');
  writeOut(ok, 'two');
  assert.equal(fs.readFileSync(ok, 'utf8'), 'two');
  assert.equal(fs.readFileSync(path.join(proj, 'target.txt'), 'utf8'), 'keep');
});

for (const [name, script, extra] of [
  ['migration-plan', 'migration-plan.js', () => ['--recs', writeRecs([])]],
  ['features', 'features.js', () => []],
  ['lib-update', 'lib-update.js', () => []],
  ['scan', 'scan.js', () => []],
]) {
  test(`${name} --out refuses link escapes into the project and directories`, () => {
    const proj = tmp();
    fs.cpSync(FA, proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'target.txt'), 'keep');
    const outside = tmp();
    fs.symlinkSync(path.join(proj, 'target.txt'), path.join(outside, 'link.json'));
    fs.symlinkSync(proj, path.join(outside, 'dirlink'));
    fs.linkSync(path.join(proj, 'target.txt'), path.join(outside, 'hard.json'));
    fs.mkdirSync(path.join(outside, 'adir'));
    const call = (out) => spawnSync(process.execPath, [path.join(root, 'skill/scripts', script), proj, ...extra(), '--out', out], { encoding: 'utf8' });
    for (const bad of ['link.json', path.join('dirlink', 'x.json'), 'hard.json', 'adir']) {
      const r = call(path.join(outside, bad));
      assert.equal(r.status, 1, `${name} ${bad}: ${r.stderr}`);
      assert.ok(!r.stderr.includes(outside), 'no raw absolute paths');
    }
    assert.equal(call(path.join(proj, 'inside.json')).status, 1);
    assert.ok(!fs.existsSync(path.join(proj, 'inside.json')));
    assert.equal(fs.readFileSync(path.join(proj, 'target.txt'), 'utf8'), 'keep');
    const good = path.join(outside, 'ok.json');
    const r = call(good);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.statSync(good).size > 0);
  });
}
