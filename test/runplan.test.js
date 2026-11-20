import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderRoadmap, checkPlan } from '../skill/scripts/lib/migplan.js';
import { parseRoadmap, loadPlan, nextRunnable, setStatus } from '../skill/scripts/lib/runplan.js';
import { writeAiFiles } from '../skill/scripts/lib/aidir.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmps = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-runplan-'));
  tmps.push(d);
  return d;
};
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const S = (id, title, extra = {}) => ({
  id, title, track: 'enabling', dimension: 'ui', from: 'x', to: 'y', dependsOn: [], tags: [], verification: [], rollback: 'revert', evidence: [], ...extra,
});
const mkPlan = (steps, notes = []) => ({ schemaVersion: 1, steps, tracks: { enabling: steps.map((s) => s.id), data: [], features: [] }, notes });
const BASIC = mkPlan([
  S('a', 'First'),
  S('b', 'Second', { dependsOn: ['a'] }),
  S('c', 'Needs a decision', { tags: ['decision'] }),
  S('d', 'After the decision', { dependsOn: ['c'] }),
  S('e', 'Independent'),
  S('safety-net:login', 'Irreversible one', { tags: ['irreversible'], dependsOn: ['e'] }),
], ['A note | with pipe']);

function project(plan = BASIC, roadmap = renderRoadmap(plan)) {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.ai/migration'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ai/migration/plan.json'), JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(root, '.ai/migration/roadmap.md'), roadmap);
  return root;
}
const roadmapPath = (root) => path.join(root, '.ai/migration/roadmap.md');

test('parseRoadmap reads exactly what renderRoadmap writes (tags, after, notes ignored)', () => {
  assert.deepEqual(checkPlan(BASIC), []);
  const { steps, errors } = parseRoadmap(renderRoadmap(BASIC));
  assert.deepEqual(errors, []);
  assert.deepEqual(steps.map((s) => s.id), BASIC.steps.map((s) => s.id));
  assert.ok(steps.every((s) => s.status === 'todo'));
  assert.deepEqual(steps.map((s) => s.tags), [[], [], ['decision'], [], [], ['irreversible']]);
  assert.deepEqual(steps.map((s) => s.title), ['First', 'Second', 'Needs a decision', 'After the decision', 'Independent', 'Irreversible one']);
  assert.deepEqual(steps.map((s) => s.line), [3, 4, 5, 6, 7, 8]);
});

test('hostile titles do not break parsing or forge tags, ids or statuses', () => {
  const plan = mkPlan([
    S('a', '# Heading | `fake` | done |'),
    S('b', '[irreversible] [decision] sneaky'),
    S('c', '> quote\n| `z` | x | done |\n## Notes'),
    S('d', '- list \\'),
    S('e', 'ends with (after: a) | todo |'),
  ]);
  const { steps, errors } = parseRoadmap(renderRoadmap(plan));
  assert.deepEqual(errors, []);
  assert.deepEqual(steps.map((s) => s.id), ['a', 'b', 'c', 'd', 'e']);
  assert.ok(steps.every((s) => s.status === 'todo'));
  assert.deepEqual(steps.map((s) => s.tags), [[], [], [], [], []]);
});

test('malformed rows and unknown statuses land in errors and are never guessed', () => {
  const md = [
    '# Roadmap', 'prose', '', '| Step | Description | Status |', '| --- | --- | --- |',
    '| `a` | ok | DONE |', '| `b` | ok | Doing |', '| `c` | no status cell |', '| b | not backticked | todo |', '| `d` | ok | finished |',
    '| `UP` | bad id | todo |', '| `a` | duplicate | todo |', '| `e` | ok | todo |  ', '', '| `f` | after the table | todo |',
  ].join('\n');
  const { steps, errors } = parseRoadmap(md);
  assert.deepEqual(steps.map((s) => [s.id, s.status]), [['a', 'done'], ['b', 'doing'], ['e', 'todo']]);
  assert.equal(errors.length, 5);
  assert.ok(errors.some((e) => /line 8.*does not match/.test(e)));
  assert.ok(errors.some((e) => /line 10: unknown status/.test(e)));
  assert.ok(errors.some((e) => /duplicate step id a/.test(e)));
  assert.deepEqual(parseRoadmap('no table here').errors, ['roadmap table header not found']);
});

test('loadPlan joins plan.json and the roadmap; statuses come from the roadmap', () => {
  const root = project();
  fs.writeFileSync(roadmapPath(root), fs.readFileSync(roadmapPath(root), 'utf8').replace('| `a` | First [no playbook] | todo |', '| `a` | First [no playbook] | done |'));
  const plan = loadPlan(root);
  assert.equal(plan.steps.find((s) => s.id === 'a').status, 'done');
  assert.equal(plan.steps.find((s) => s.id === 'b').status, 'todo');
  assert.deepEqual(plan.steps.find((s) => s.id === 'b').dependsOn, ['a']);
});

test('loadPlan refuses mismatches, invalid plans and bad files', () => {
  const root = project(BASIC, renderRoadmap(BASIC).replace('| --- | --- | --- |\n', '| --- | --- | --- |\n| `zzz` | extra | todo |\n'));
  assert.throws(() => loadPlan(root), /row zzz has no step in \.ai\/migration\/plan\.json/);
  const missingRow = project(BASIC, renderRoadmap(mkPlan(BASIC.steps.slice(1).map((s) => ({ ...s, dependsOn: [] })))));
  assert.throws(() => loadPlan(missingRow), /no row for plan step a/);
  const cyclic = project(mkPlan([S('a', 'A', { dependsOn: ['b'] }), S('b', 'B', { dependsOn: ['a'] })]));
  assert.throws(() => loadPlan(cyclic), /plan\.json: dependsOn forms a cycle/);
  const dangling = project(mkPlan([S('a', 'A', { dependsOn: ['nope'] })]));
  assert.throws(() => loadPlan(dangling), /does not exist/);
  const badRow = project(BASIC, renderRoadmap(BASIC).replace('| todo |', '| later |'));
  assert.throws(() => loadPlan(badRow), /roadmap\.md: roadmap line 3: unknown status/);
  const none = tmp();
  assert.throws(() => loadPlan(none), /plan\.json: not found/);
  const sym = project();
  fs.rmSync(roadmapPath(sym));
  fs.symlinkSync(path.join(sym, '.ai/migration/plan.json'), roadmapPath(sym));
  assert.throws(() => loadPlan(sym), /must be a regular file/);
});

const plan = (statuses, steps = BASIC.steps) => ({ steps: steps.map((s) => ({ ...s, status: statuses[s.id] ?? 'todo' })) });

test('nextRunnable: dependency order, gated step skipped, independent steps still run', () => {
  const p = plan({});
  let r = nextRunnable(p);
  assert.equal(r.step.id, 'a');
  assert.match(r.reason, /no dependencies/);
  r = nextRunnable(plan({ a: 'done' }));
  assert.equal(r.step.id, 'b');
  assert.match(r.reason, /dependencies done/);
  // a and b done: c is gated, d is blocked behind it, e (independent) runs.
  assert.equal(nextRunnable(plan({ a: 'done', b: 'done' })).step.id, 'e');
  // doing steps are not picked again
  assert.equal(nextRunnable(plan({ a: 'doing' })).step.id, 'e');
});

test('nextRunnable: skip, only-gated, blocked and done', () => {
  const allDone = Object.fromEntries(BASIC.steps.map((s) => [s.id, 'done']));
  assert.deepEqual(nextRunnable(plan(allDone)), { done: true, doing: [] });
  const onlyGated = nextRunnable(plan({ ...allDone, c: 'todo', 'safety-net:login': 'todo', d: 'todo' }));
  assert.deepEqual(onlyGated.gated.map((s) => s.id), ['c', 'safety-net:login']);
  // a skipped (failed) step blocks its dependents, independent ones run
  const skipped = nextRunnable(plan({}), { skip: new Set(['a']) });
  assert.equal(skipped.step.id, 'e');
  const rest = nextRunnable(plan({ e: 'done', 'safety-net:login': 'done' }), { skip: new Set(['a']) });
  assert.deepEqual(rest.gated.map((s) => s.id), ['c']);
  const blocked = nextRunnable(plan({ ...allDone, a: 'todo', b: 'todo' }), { skip: new Set(['a']) });
  assert.deepEqual(blocked.blocked.map((s) => s.id), ['a', 'b']);
  // a gated dependency that is not done keeps its dependent out of the gated list
  const behind = nextRunnable(plan({ ...allDone, c: 'todo', d: 'todo', 'safety-net:login': 'done' }));
  assert.deepEqual(behind.gated.map((s) => s.id), ['c']);
});

test('setStatus changes one cell and leaves every other byte identical', () => {
  const crlf = renderRoadmap(BASIC).replace('| `b` | Second [no playbook] (after: a) | todo |', '| `b` | Second [no playbook] (after: a) |   Todo  |').replaceAll('\n', '\r\n');
  const root = project(BASIC, crlf);
  const before = fs.readFileSync(roadmapPath(root), 'utf8');
  assert.deepEqual(setStatus(root, 'b', 'doing'), { previous: 'todo' });
  const after = fs.readFileSync(roadmapPath(root), 'utf8');
  const bl = before.split('\n');
  const al = after.split('\n');
  assert.equal(al.length, bl.length);
  const diff = al.map((l, i) => i).filter((i) => al[i] !== bl[i]);
  assert.equal(diff.length, 1);
  assert.equal(al[diff[0]], bl[diff[0]].replace('Todo', 'doing'));
  assert.equal(fs.readdirSync(path.join(root, '.ai/migration')).length, 2, 'no temp file left');
  assert.deepEqual(setStatus(root, 'b', 'doing'), { previous: 'doing' });
  assert.equal(loadPlan(root).steps.find((s) => s.id === 'b').status, 'doing');
});

test('setStatus guards: expected previous status, exact id, valid values', () => {
  const root = project();
  const before = fs.readFileSync(roadmapPath(root), 'utf8');
  assert.throws(() => setStatus(root, 'a', 'done', 'doing'), /step a is todo, expected doing/);
  assert.throws(() => setStatus(root, 'a', 'finished'), /status must be/);
  assert.throws(() => setStatus(root, 'missing', 'done'), /no row for step missing/);
  assert.throws(() => setStatus(root, 'a`; x', 'done'), /invalid step id/);
  assert.throws(() => setStatus(root, 'aa', 'done'), /no row/);
  assert.equal(fs.readFileSync(roadmapPath(root), 'utf8'), before);
  setStatus(root, 'a', 'doing', 'todo');
  setStatus(root, 'a', 'done', { expect: 'doing' });
  assert.equal(parseRoadmap(fs.readFileSync(roadmapPath(root), 'utf8')).steps[0].status, 'done');
  assert.ok(fs.readFileSync(roadmapPath(root), 'utf8').includes('## Notes'));
});

test('setStatus refuses a symlinked roadmap or .ai folder and leaves the target alone', () => {
  const root = project();
  const real = path.join(root, 'real.md');
  fs.writeFileSync(real, renderRoadmap(BASIC));
  fs.rmSync(roadmapPath(root));
  fs.symlinkSync(real, roadmapPath(root));
  assert.throws(() => setStatus(root, 'a', 'done'), /regular file/);
  assert.equal(fs.readFileSync(real, 'utf8'), renderRoadmap(BASIC));
  const other = project();
  const moved = path.join(other, 'moved');
  fs.renameSync(path.join(other, '.ai'), moved);
  fs.symlinkSync(moved, path.join(other, '.ai'));
  assert.throws(() => setStatus(other, 'a', 'done'), /symlink|regular file/);
});

// migration-plan.js --write

const cli = path.join(repo, 'skill/scripts/migration-plan.js');
function gradleProject() {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'settings.gradle.kts'), 'rootProject.name = "demo"\n');
  fs.writeFileSync(path.join(root, 'build.gradle.kts'), '');
  const recs = path.join(tmp(), 'recs.json');
  fs.writeFileSync(recs, JSON.stringify({ schemaVersion: 1, catalogVersion: JSON.parse(fs.readFileSync(path.join(repo, 'skill/catalog/catalog.json'), 'utf8')).catalogVersion, generatedAt: '2026-11-20', dimensions: [], steps: [] }));
  return { root, recs };
}
const runCli = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('migration-plan --write: plan.json, and the template roadmap table is replaced once', () => {
  const { root, recs } = gradleProject();
  fs.mkdirSync(path.join(root, '.ai/migration'), { recursive: true });
  const tpl = fs.readFileSync(path.join(repo, 'skill/templates/ai/migration/roadmap.md'), 'utf8');
  fs.writeFileSync(roadmapPath(root), tpl);
  const r = runCli([root, '--recs', recs, '--write']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote \.ai\/migration\/plan\.json/);
  assert.match(r.stdout, /wrote \.ai\/migration\/roadmap\.md/);
  const plan = JSON.parse(fs.readFileSync(path.join(root, '.ai/migration/plan.json'), 'utf8'));
  assert.equal(plan.schemaVersion, 1);
  const md = fs.readFileSync(roadmapPath(root), 'utf8');
  assert.ok(!md.includes('TODO: run "setup"'));
  assert.ok(md.includes('One step per pull request.') && md.includes('| Step | Description | Status |'));
  assert.equal(md.split('| Step | Description | Status |').length, 2);
  assert.deepEqual(parseRoadmap(md).errors, []);
  assert.equal(parseRoadmap(md).steps.length, plan.steps.length);
  assert.equal(loadPlan(root).steps.length, plan.steps.length);
  // A second run never replaces the roadmap again: it has rows now, so the proposal goes to .new.
  const edited = md.replace('| --- | --- | --- |\n', '| --- | --- | --- |\n| `a` | x | done |\n');
  assert.notEqual(edited, md);
  fs.writeFileSync(roadmapPath(root), edited);
  const r2 = runCli([root, '--recs', recs, '--write']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /roadmap\.md\.new/);
  assert.equal(fs.readFileSync(roadmapPath(root), 'utf8'), edited);
  assert.ok(fs.existsSync(path.join(root, '.ai/migration/roadmap.md.new')));
});

const PLACEHOLDER = `${'TO'}${'DO'}: run "setup" in your agent`;
function writeRoadmapCase(content) {
  const { root, recs } = gradleProject();
  fs.mkdirSync(path.join(root, '.ai/migration'), { recursive: true });
  fs.writeFileSync(roadmapPath(root), content);
  const r = runCli([root, '--recs', recs, '--write']);
  assert.equal(r.status, 0, r.stderr);
  return { root, r, md: fs.readFileSync(roadmapPath(root)), hasNew: fs.existsSync(path.join(root, '.ai/migration/roadmap.md.new')) };
}
const EMPTY_TABLE = '| Step | Description | Status |\n| --- | --- | --- |\n';

test('--write keeps text before and after an empty table verbatim and drops only the placeholder line', () => {
  const { md, hasNew } = writeRoadmapCase(`# Mine\n\n${PLACEHOLDER}\n\nIntro \u00e9 text\n\n${EMPTY_TABLE}\n## My notes\n\nkeep me | here\n`);
  const text = md.toString('utf8');
  assert.equal(hasNew, false);
  assert.ok(text.startsWith('# Mine\n\n\nIntro \u00e9 text\n\n| Step |'));
  assert.ok(text.endsWith('\n\n## My notes\n\nkeep me | here\n'));
  assert.ok(!text.includes(PLACEHOLDER));
});

test('--write preserves CRLF line endings', () => {
  const { md } = writeRoadmapCase(`# Mine\r\n\r\n${EMPTY_TABLE.replaceAll('\n', '\r\n')}\r\nafter\r\n`);
  const text = md.toString('utf8');
  assert.ok(!/[^\r]\n/.test(text), 'every newline is CRLF');
  assert.ok(text.includes('| Step |') && text.endsWith('after\r\n'));
});

test('--write: the marker in prose does not trigger replacement; rows with the placeholder present go to .new', () => {
  const prose = `# R\n\nThe old file said: ${PLACEHOLDER}\n\nmy own text\n`;
  const a = writeRoadmapCase(prose);
  assert.equal(a.md.toString('utf8'), prose);
  assert.ok(a.hasNew);
  const rows = `# R\n\n${PLACEHOLDER}\n\n${EMPTY_TABLE}| \`a\` | hand written | doing |\n`;
  const b = writeRoadmapCase(rows);
  assert.equal(b.md.toString('utf8'), rows);
  assert.ok(b.hasNew);
  const fenced = `# R\n\n\`\`\`\n${EMPTY_TABLE}| \`a\` | in a fence | todo |\n\`\`\`\n`;
  assert.ok(writeRoadmapCase(fenced).hasNew);
});

test('--write keeps non-UTF-8 bytes around the table', () => {
  const pre = Buffer.from([0x23, 0x20, 0xe9, 0xff, 0x0a, 0x0a]);
  const post = Buffer.from([0x0a, 0x80, 0xfe, 0x0a]);
  const { md } = writeRoadmapCase(Buffer.concat([pre, Buffer.from(EMPTY_TABLE), post]));
  assert.ok(md.subarray(0, pre.length).equals(pre));
  assert.ok(md.subarray(md.length - post.length).equals(post));
});

test('parseRoadmap uses the first header outside fenced code', () => {
  const md = `\`\`\`\n${EMPTY_TABLE}| \`fake\` | x | done |\n\`\`\`\n\n${EMPTY_TABLE}| \`real\` | x | todo |\n`;
  assert.deepEqual(parseRoadmap(md).steps.map((x) => x.id), ['real']);
});

test('setStatus round-trips non-UTF-8 bytes and keeps content after the table', () => {
  const root = project();
  const raw = Buffer.concat([Buffer.from(renderRoadmap(BASIC)), Buffer.from([0x0a, 0xe9, 0xff, 0x80, 0x0a])]);
  fs.writeFileSync(roadmapPath(root), raw);
  setStatus(root, 'a', 'doing');
  const out = fs.readFileSync(roadmapPath(root));
  assert.ok(out.subarray(out.length - 5).equals(raw.subarray(raw.length - 5)));
  assert.equal(out.length, raw.length - 'todo'.length + 'doing'.length);
});

test('writeAiFiles only writes the migration plan files, and keeps the file mode', () => {
  const root = project();
  const before = fs.readFileSync(roadmapPath(root));
  for (const rel of ['knowledge/conventions.md', 'run.config.json', 'migration/other.md', '../x']) {
    assert.throws(() => writeAiFiles(root, { [rel]: 'x' }), /outside the migration plan files/);
  }
  assert.throws(() => writeAiFiles(root, { 'migration/plan.json': 'ok', 'run.config.json': 'x' }), /outside/);
  assert.ok(fs.readFileSync(roadmapPath(root)).equals(before));
  assert.equal(fs.readFileSync(path.join(root, '.ai/migration/plan.json'), 'utf8').includes('"steps"'), true, 'nothing was written');
  fs.chmodSync(roadmapPath(root), 0o640);
  writeAiFiles(root, { 'migration/roadmap.md': 'new\n' });
  assert.equal(fs.statSync(roadmapPath(root)).mode & 0o777, 0o640);
});

test('nextRunnable reports doing steps in every variant and coerces skip', () => {
  const p = plan({ a: 'doing' });
  assert.deepEqual(nextRunnable(p).doing.map((x) => x.id), ['a']);
  assert.equal(nextRunnable(plan({}), { skip: ['a'] }).step.id, 'e');
  for (const skip of [null, undefined, [], ['zzz']]) assert.ok(nextRunnable(plan({}), { skip }).step);
  assert.ok(Array.isArray(nextRunnable(plan(Object.fromEntries(BASIC.steps.map((x) => [x.id, 'done'])))).doing));
  assert.ok(Array.isArray(nextRunnable(plan({}), { skip: new Set(BASIC.steps.map((x) => x.id)) }).blocked));
});

test('migration-plan --write needs .ai and refuses a symlinked roadmap', () => {
  const { root, recs } = gradleProject();
  const r = runCli([root, '--recs', recs, '--write']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no \.ai folder/);
  assert.ok(!fs.existsSync(path.join(root, '.ai')));
  fs.mkdirSync(path.join(root, '.ai/migration'), { recursive: true });
  const target = path.join(root, 'elsewhere.md');
  fs.writeFileSync(target, 'keep\n');
  fs.symlinkSync(target, roadmapPath(root));
  const r2 = runCli([root, '--recs', recs, '--write']);
  assert.equal(r2.status, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n');
  assert.ok(!fs.existsSync(path.join(root, '.ai/migration/plan.json')), 'nothing written when a target is refused');
});

test('migration-plan without --write still never writes into the project', () => {
  const { root, recs } = gradleProject();
  fs.mkdirSync(path.join(root, '.ai'));
  const out = execFileSync(process.execPath, [cli, root, '--recs', recs], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).schemaVersion, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, '.ai')), []);
});
