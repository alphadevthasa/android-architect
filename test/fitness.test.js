import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAdr } from '../skill/scripts/lib/adr.js';
import { discoverModules } from '../skill/scripts/lib/modules.js';
import { listFiles } from '../skill/scripts/lib/walk.js';
import { matchGlob } from '../skill/scripts/lib/overrides.js';
import { globToRegExp } from '../skill/scripts/lib/glob.js';
import { scanInstructions, scanAiDir } from '../skill/scripts/lib/injection.js';
import {
  parseFitnessRules, checkFitness, generateFitness, kotlinString, matchModuleGlob, matchPackageGlob, validModules,
} from '../skill/scripts/lib/fitness.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fitness-app', import.meta.url));
const SKILL = path.resolve('skill');
const CLI = path.join(SKILL, 'scripts/fitness.js');
const HELPER = path.resolve('test/helpers/no-network.mjs');
const MODULE_RULE = 'module-no-dep: :feature:* -> :feature:*';
const PACKAGE_RULE = 'package-no-import: com.example.ui.* -> com.example.data.db.';

const adrText = (status, rules) => [
  '---', 'id: "0001"', 'title: Feature isolation', `status: ${status}`, 'date: 2026-11-20',
  ...(rules === null ? [] : ['fitness:', ...rules.map((r) => `  - "${r}"`)]), '---', '', '# 0001 Feature isolation', '',
].join('\n');
const adrObj = (fitness, status = 'accepted', file = '0001-x.md') => ({ id: '0001', title: 't', status, fitness, file });

/** A temp copy of the fixture with .ai/knowledge/adr holding the given ADR files ({ name: text }). */
function project(adrs = { '0001-feature-isolation.md': adrText('accepted', [MODULE_RULE]) }, { ai = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fitness-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  if (ai) {
    fs.mkdirSync(path.join(dir, '.ai/knowledge/adr'), { recursive: true });
    for (const [n, t] of Object.entries(adrs)) fs.writeFileSync(path.join(dir, '.ai/knowledge/adr', n), t);
  }
  return dir;
}
const cleanup = (d) => fs.rmSync(d, { recursive: true, force: true });
const cli = (args) => spawnSync(process.execPath, ['--import', HELPER, CLI, ...args], { encoding: 'utf8' });
const rulesOf = (texts, status) => parseFitnessRules([adrObj(texts, status)]);

// ---------- glob grammar ----------

test('matchGlob agrees with the override glob regex for the override grammar', () => {
  const cases = [
    ['**/build.gradle', ['build.gradle', 'app/build.gradle', 'a/b/build.gradle', 'app/build.gradle.kts']],
    ['src/*.kt', ['src/A.kt', 'src/a/B.kt', 'src/.kt', 'src/A.java']],
    ['**/src/*Test.kt', ['x/src/FooTest.kt', 'src/Test.kt', 'src/FooTest.kts', 'a/b/src/c/FooTest.kt']],
    ['app/res/layout', ['app/res/layout', 'app/res/layout/x']],
  ];
  for (const [g, texts] of cases) {
    for (const t of texts) assert.equal(matchGlob(g, t), globToRegExp(g).test(t), `${g} vs ${t}`);
  }
});

test('matchGlob refuses patterns outside the tiny grammar instead of guessing', () => {
  assert.throws(() => matchGlob('*a*a*b', 'aaab'));
  assert.throws(() => matchGlob('a/**b/c', 'a/xb/c'));
});

test('module globs use ":" segments; a trailing "**" matches any depth', () => {
  assert.equal(matchModuleGlob(':feature:*', ':feature:login'), true);
  assert.equal(matchModuleGlob(':feature:*', ':feature:login:impl'), false);
  assert.equal(matchModuleGlob(':feature:*', ':feature'), false);
  assert.equal(matchModuleGlob(':feature:**', ':feature:login:impl'), true);
  assert.equal(matchModuleGlob(':feature:**', ':feature'), false);
  assert.equal(matchModuleGlob(':**:data', ':core:data'), true);
  assert.equal(matchModuleGlob(':**:data', ':data'), true);
  assert.equal(matchModuleGlob(':core:*-api', ':core:net-api'), true);
  assert.equal(matchModuleGlob(':*', ':'), false);
  assert.equal(matchModuleGlob(':app', ':app'), true);
});

test('package globs use "." segments', () => {
  assert.equal(matchPackageGlob('com.example.ui.*', 'com.example.ui.login'), true);
  assert.equal(matchPackageGlob('com.example.ui.*', 'com.example.ui.login.x'), false);
  assert.equal(matchPackageGlob('com.example.ui.**', 'com.example.ui.login.x'), true);
  assert.equal(matchPackageGlob('com.example.ui.*', ''), false);
});

test('an allowed worst-case glob matches a 1 MB path quickly', () => {
  const long = ':' + 'a'.repeat(1024 * 1024) + ':ab';
  const t = performance.now();
  assert.equal(matchModuleGlob(':**:a*b', long), true);
  assert.equal(matchModuleGlob(':x*:**', long), false);
  assert.ok(performance.now() - t < 50, 'linear matching');
});

// ---------- ADR key ----------

test('ADR front matter accepts an optional fitness list; ADRs without it are unchanged', () => {
  const a = parseAdr(adrText('accepted', [MODULE_RULE]), '0001-a.md');
  assert.deepEqual(a.fitness, [MODULE_RULE]);
  const empty = parseAdr(adrText('accepted', []), '0001-a.md');
  assert.deepEqual(empty.fitness, []);
  const none = parseAdr(adrText('accepted', null), '0001-a.md');
  assert.equal('fitness' in none, false);
  assert.throws(() => parseAdr(adrText('accepted', null).replace('---\n\n', 'fitness: x\n---\n\n'), '0001-a.md'), /must be a list/);
});

// ---------- rules ----------

test('parseFitnessRules: accepted ADRs contribute rules, other statuses only a note', () => {
  const ok = parseFitnessRules([adrObj([MODULE_RULE, PACKAGE_RULE], 'accepted', '0001-feature-isolation.md')]);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.rules, [
    { id: '0001-feature-isolation-r1', adr: '0001-feature-isolation.md', kind: 'module-no-dep', from: ':feature:*', to: ':feature:*' },
    { id: '0001-feature-isolation-r2', adr: '0001-feature-isolation.md', kind: 'package-no-import', from: 'com.example.ui.*', to: 'com.example.data.db.' },
  ]);
  for (const status of ['proposed', 'rejected', 'superseded']) {
    const r = rulesOf([MODULE_RULE], status);
    assert.deepEqual(r.rules, []);
    assert.deepEqual(r.errors, []);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0], new RegExp(`^0001-x\\.md: .*${status}`));
  }
});

test('hostile rule text is rejected with a rule-prefixed error and produces nothing', () => {
  const hostile = [
    'module-no-dep: :feature:a" -> :feature:b',
    'module-no-dep: :feature:$x -> :feature:b',
    'module-no-dep: :feature:${x} -> :feature:b',
    'module-no-dep: :feature:`x` -> :feature:b',
    'module-no-dep: :feature:a\n -> :feature:b',
    'module-no-dep: :feature:a -> :feature:b; rm -rf x',
    `module-no-dep: :${'a'.repeat(201)} -> :b`,
    'module-no-dep: **/**/** -> :b',
    'module-no-dep: *a*a*a*a*a*a*a*b -> :b',
    'module-no-dep: :a:*a*a*a*a*a*a*a*b -> :b',
    'package-no-import: com.example.**.x.** -> a.b.',
    'package-no-import: com.example.ui.* -> a.*.b',
    'module-no-dep: :feature:a\u2028 -> :feature:b',
    'module-no-dep: :feature:a\u202e -> :feature:b',
    'module-no-dep: :feature:a */ -> :feature:b',
    'module-no-dep: :feature:a -> :feature:b -> :core:x',
    'shell-exec: :a -> :b',
    'module-no-dep: :a:password=hunter2hunter2 -> :b',
    'module-no-dep: :a:AKIAABCDEFGHIJKLMNOP -> :b',
    '',
  ];
  for (const h of hostile) {
    const r = rulesOf([h]);
    assert.deepEqual(r.rules, [], JSON.stringify(h));
    assert.equal(r.errors.length, 1, JSON.stringify(h));
    assert.match(r.errors[0], /^0001-x\.md: rule "1": \S/, JSON.stringify(h));
    assert.ok(!r.errors[0].includes('hunter2') && !r.errors[0].includes('AKIA'), 'no secret echoed');
    const files = generateFitness(r.rules, []);
    for (const text of Object.values(files)) {
      assert.ok(!text.includes('hunter2') && !text.includes('AKIAABCD') && !text.includes('rm -rf'));
    }
  }
  const many = rulesOf(Array.from({ length: 21 }, (_, i) => `module-no-dep: :m${i} -> :x`));
  assert.deepEqual(many.rules, []);
  assert.equal(many.errors.length, 1);
  assert.match(many.errors[0], /^0001-x\.md: rule "21": .*20/);
  const twenty = rulesOf(Array.from({ length: 20 }, (_, i) => `module-no-dep: :m${i} -> :x`));
  assert.equal(twenty.rules.length, 20);
});

test('hostile ADR file names and ids are sanitized in rule ids and errors', () => {
  const r = parseFitnessRules([adrObj(['bad', MODULE_RULE], 'accepted', '0001-*/ x\n// y.md')]);
  assert.match(r.errors[0], /^[A-Za-z0-9_.-]+: rule "1": /);
  assert.match(r.rules[0].id, /^[A-Za-z0-9_.-]+$/);
  assert.match(r.rules[0].adr, /^[A-Za-z0-9_.-]+$/);
});

// ---------- static check ----------

test('checkFitness: one forbidden module dependency with build file and line; none after removing it', () => {
  const dir = project();
  try {
    const { rules } = rulesOf([MODULE_RULE]);
    const r = checkFitness(dir, rules);
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations, [{ rule: '0001-x-r1', from: ':feature:a', to: ':feature:b', file: 'feature/a/build.gradle', line: 13 }]);
    const build = path.join(dir, 'feature/a/build.gradle');
    fs.writeFileSync(build, fs.readFileSync(build, 'utf8').replace("    implementation project(':feature:b')\n", ''));
    const clean = checkFitness(dir, rules);
    assert.equal(clean.ok, true);
    assert.deepEqual(clean.violations, []);
  } finally {
    cleanup(dir);
  }
});

test('checkFitness: package rule reports the import with file and line', () => {
  const { rules } = rulesOf([PACKAGE_RULE]);
  const r = checkFitness(FIXTURE, rules);
  assert.deepEqual(r.violations, [
    { rule: '0001-x-r1', from: 'com.example.ui.login', to: 'com.example.data.db.UserDao', file: 'feature/a/src/main/kotlin/com/example/ui/login/LoginScreen.kt', line: 3 },
    { rule: '0001-x-r1', from: 'com.example.ui.home', to: 'com.example.data.db.*', file: 'feature/b/src/main/java/com/example/ui/home/HomeView.java', line: 3 },
  ]);
  const wildcard = checkFitness(FIXTURE, rulesOf(['package-no-import: com.example.ui.* -> com.example.data.*']).rules);
  assert.equal(wildcard.violations.length, 2);
  assert.deepEqual(checkFitness(FIXTURE, rulesOf(['package-no-import: com.example.ui.* -> com.example.net.']).rules).violations, []);
});

test('checkFitness reads the first 1 MB of a larger file and counts it as truncated', () => {
  const dir = project();
  try {
    const big = 'feature/a/src/main/kotlin/com/example/ui/login/Big.kt';
    fs.writeFileSync(path.join(dir, big), 'package com.example.ui.login\n\nimport com.example.data.db.Big\n' + '//x\n'.repeat(300000));
    const r = checkFitness(dir, rulesOf([PACKAGE_RULE]).rules);
    assert.equal(r.truncatedFiles, 1);
    assert.equal(r.skippedFiles, 0);
    assert.ok(r.notes.some((n) => /1 source file over 1 MB/.test(n)));
    assert.ok(r.violations.some((v) => v.file === big && v.line === 3 && v.to === 'com.example.data.db.Big'));
  } finally {
    cleanup(dir);
  }
});

test('package and import lines inside block comments and strings are ignored', () => {
  const dir = project();
  try {
    const f = 'feature/a/src/main/kotlin/com/example/ui/login/Commented.kt';
    fs.writeFileSync(path.join(dir, f), [
      '/* package com.example.fake',
      'import com.example.data.db.InComment */',
      'package com.example.ui.login',
      '',
      '/*',
      'import com.example.data.db.AlsoInComment',
      '*/',
      'import com.example.data.db.Real',
      'val s = """',
      'import com.example.data.db.InRawString',
      '"""',
      'val t = "/* not a comment"',
      'import com.example.data.db.AfterString',
    ].join('\n'));
    const r = checkFitness(dir, rulesOf([PACKAGE_RULE]).rules);
    const mine = r.violations.filter((v) => v.file === f);
    assert.deepEqual(mine.map((v) => [v.from, v.to, v.line]), [
      ['com.example.ui.login', 'com.example.data.db.Real', 8],
      ['com.example.ui.login', 'com.example.data.db.AfterString', 13],
    ]);
  } finally {
    cleanup(dir);
  }
});

test('a malformed package name such as a trailing dot never matches', () => {
  assert.equal(matchPackageGlob('com.example.*', 'com.example.'), false);
  assert.equal(matchPackageGlob('com.**', 'com..x'), false);
  assert.equal(matchPackageGlob('com.example.*', 'com.example.x'), true);
});

test('zero rules: no Gradle script and no Konsist test; package rules only: no Gradle script', () => {
  const none = generateFitness([], []);
  assert.deepEqual(Object.keys(none).sort(), ['README.md', 'verify-commands.json']);
  assert.match(none['README.md'], /no Gradle script and no Konsist test/);
  const pkg = generateFitness(rulesOf([PACKAGE_RULE]).rules, []);
  assert.deepEqual(Object.keys(pkg).sort(), ['ArchitectureFitnessTest.kt', 'README.md', 'verify-commands.json']);
  assert.deepEqual(scanInstructions(pkg['README.md']), []);
});

test('CLI removes its own generated files that a run no longer produces', () => {
  const dir = project();
  try {
    assert.equal(cli([dir]).status, 0);
    fs.writeFileSync(path.join(dir, '.ai/knowledge/adr/0001-feature-isolation.md'), adrText('accepted', [PACKAGE_RULE]));
    const r = cli([dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).removed, ['.ai/fitness/architecture-fitness.gradle.kts']);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.ai/fitness')).sort(), ['ArchitectureFitnessTest.kt', 'README.md', 'verify-commands.json']);
  } finally {
    cleanup(dir);
  }
});

test('CLI refuses non-regular targets before any write', () => {
  const listing = (d) => {
    const f = path.join(d, '.ai/fitness');
    return fs.existsSync(f) && fs.lstatSync(f).isDirectory() ? fs.readdirSync(f).sort() : null;
  };
  const cases = [
    ['README.md as a directory', (d) => fs.mkdirSync(path.join(d, '.ai/fitness/README.md'), { recursive: true })],
    ['.ai/fitness as a regular file', (d) => fs.writeFileSync(path.join(d, '.ai/fitness'), 'x')],
  ];
  const probe = spawnSync('mkfifo', [path.join(os.tmpdir(), `aa-fifo-probe-${process.pid}`)]);
  if (probe.status === 0) {
    fs.rmSync(path.join(os.tmpdir(), `aa-fifo-probe-${process.pid}`), { force: true });
    cases.push(['README.md as a FIFO', (d) => {
      fs.mkdirSync(path.join(d, '.ai/fitness'), { recursive: true });
      assert.equal(spawnSync('mkfifo', [path.join(d, '.ai/fitness/README.md')]).status, 0);
    }]);
  }
  for (const [name, setup] of cases) {
    const dir = project();
    try {
      setup(dir);
      const before = listing(dir);
      const r = cli([dir]);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, /refusing/, name);
      assert.ok(!r.stderr.includes(dir), `${name}: no absolute path`);
      assert.deepEqual(listing(dir), before, `${name}: nothing written`);
    } finally {
      cleanup(dir);
    }
  }
});

test('CLI refuses a symlinked .ai with a symlink message', () => {
  const dir = project({}, { ai: false });
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fitness-ai-'));
  try {
    fs.symlinkSync(real, path.join(dir, '.ai'));
    for (const args of [[dir], [dir, '--check']]) {
      const r = cli(args);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /symlink/);
    }
    assert.deepEqual(fs.readdirSync(real), []);
  } finally {
    cleanup(dir);
    cleanup(real);
  }
});

test('CLI in a workspace member notes that ADRs live in the hub', () => {
  const dir = project({});
  try {
    fs.writeFileSync(path.join(dir, '.ai/manifest.json'), JSON.stringify({ schemaVersion: 1, workspace: { role: 'member', hub: '../hub' } }));
    const r = cli([dir, '--check']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).notes.some((n) => /ADRs live in the hub; run fitness from the hub/.test(n)));
  } finally {
    cleanup(dir);
  }
});

test('CLI: ADR parse errors are printed on one line without control or direction characters', () => {
  const dir = project({ '0001-bad.md': '---\nid: "1"\ntitle: x\u202e\u2028y\nstatus: maybe\n---\n' });
  try {
    const r = cli([dir, '--check']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trimEnd().split('\n').length, 1);
    assert.ok(!/[\u202e\u2028]/.test(r.stderr));
  } finally {
    cleanup(dir);
  }
});

test('modules whose path or directory fall outside the safe character set are skipped with a note', () => {
  const mods = [
    { path: ':feature:a', dir: 'feature/a', buildFile: null, build: { dependencies: [] }, projectDeps: [] },
    { path: ':feature:x"; rm', dir: 'feature/x', buildFile: null, build: { dependencies: [] }, projectDeps: [] },
    { path: ':feature:y', dir: '../outside', buildFile: null, build: { dependencies: [] }, projectDeps: [] },
  ];
  const v = validModules(mods);
  assert.deepEqual(v.modules.map((m) => m.path), [':feature:a']);
  assert.equal(v.notes.length, 2);
  for (const n of v.notes) assert.ok(!n.includes('"') && !n.includes('..'), n);
  const files = generateFitness(rulesOf([MODULE_RULE]).rules, mods);
  for (const text of Object.values(files)) {
    assert.ok(!text.includes('x"') && !text.includes('; rm') && !text.includes('feature/x') && !text.includes('../outside'));
  }
  assert.match(files['README.md'], /2 modules? (were )?skipped/);
});

// ---------- generation ----------

/** Tokenizes Kotlin: returns { strings, balanced } after removing comments; throws on an unterminated string or comment. */
function tokenize(text) {
  const strings = [];
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let balanced = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment');
      i = end + 1;
    } else if (c === '"') {
      if (text.startsWith('"""', i)) throw new Error('raw string');
      let s = '';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\n') throw new Error('newline in string');
        if (text[i] === '\\') { s += text[i] + text[i + 1]; i += 2; continue; }
        s += text[i++];
      }
      if (i >= text.length) throw new Error('unterminated string');
      strings.push(s);
    } else if (c === "'") {
      throw new Error('char literal');
    } else if ('([{'.includes(c)) stack.push(c);
    else if (')]}'.includes(c)) { if (stack.pop() !== pairs[c]) balanced = false; }
  }
  return { strings, balanced: balanced && stack.length === 0 };
}
// Line shapes: string literals -> S, digits -> 0. Hostile-looking but valid values must not create new shapes.
const shapes = (text) => new Set(text.split('\n').map((l) => l.replace(/"(?:[^"\\]|\\.)*"/g, 'S').replace(/[0-9]+/g, '0')));
const SAFE = /^[A-Za-z0-9_.:\-/*]+$/;

test('generated Gradle script and Konsist test are structurally safe Kotlin', () => {
  const { rules } = parseFitnessRules([adrObj([MODULE_RULE, PACKAGE_RULE], 'accepted', '0001-feature-isolation.md')]);
  const { modules } = validModules(discoverFixture());
  // Reference output with benign rules of both kinds: its literals are the fixed code literals.
  const base = generateFitness(parseFitnessRules([adrObj(['module-no-dep: :qq -> :qq', 'package-no-import: qq.* -> qq.'], 'accepted', '9999-base.md')]).rules, modules);
  const files = generateFitness(rules, modules);
  assert.deepEqual(Object.keys(files).sort(), ['ArchitectureFitnessTest.kt', 'README.md', 'architecture-fitness.gradle.kts', 'verify-commands.json']);
  const gradle = files['architecture-fitness.gradle.kts'];
  const konsist = files['ArchitectureFitnessTest.kt'];
  assert.match(gradle, /tasks\.register\("architectureFitness"\)/);
  assert.match(gradle, /plugins\.withId\("base"\) \{\n {4}tasks\.named\("check"\) \{\n {8}dependsOn\(architectureFitness\)/);
  assert.ok(gradle.includes('val target = dependency.path') && !gradle.includes('dependencyProject'));
  assert.match(gradle, /Gradle 8\.11 or newer/);
  assert.ok(!gradle.includes('tasks.matching'));
  assert.match(files['README.md'], /Gradle 8\.11 or newer/);
  assert.ok(gradle.includes('":feature:*"'));
  assert.ok(gradle.includes('0001-feature-isolation.md'));
  assert.ok(konsist.includes('"com.example.ui.*"') && konsist.includes('"com.example.data.db."'));
  assert.ok(konsist.includes('Konsist.scopeFromModule') && konsist.includes('"feature/a"'));
  assert.ok(konsist.includes('0001-feature-isolation.md'));
  for (const [name, text] of [['gradle', gradle], ['konsist', konsist]]) {
    assert.ok(!text.includes('$'), `${name}: no $`);
    assert.ok(!/exec|ProcessBuilder|Runtime|URL\(|http/.test(text.replace(/^\s*\/\/.*$/gm, '')), `${name}: no exec or network`);
    const t = tokenize(text);
    assert.ok(t.balanced, `${name}: balanced`);
    // Every literal not in the rule-free output is a rule value: it must be in the safe set.
    const fixed = new Set(tokenize(name === 'gradle' ? base['architecture-fitness.gradle.kts'] : base['ArchitectureFitnessTest.kt']).strings);
    for (const s of t.strings) if (!fixed.has(s)) assert.match(s, SAFE, `${name}: literal ${s}`);
  }
  assert.deepEqual(JSON.parse(files['verify-commands.json']), {
    schemaVersion: 1,
    commands: ['./gradlew architectureFitness', "./gradlew testDebugUnitTest --tests '*ArchitectureFitnessTest'"],
  });
  for (const text of Object.values(files)) assert.deepEqual(scanInstructions(text), []);
  assert.match(files['README.md'], /review/i);
});

test('odd but valid values add no new code shapes', () => {
  const { modules } = validModules(discoverFixture());
  const one = parseFitnessRules([adrObj([MODULE_RULE, PACKAGE_RULE])]).rules;
  const odd = parseFitnessRules([adrObj([
    'module-no-dep: :**:a-b_c.d -> :x*:**',
    'package-no-import: **.ui -> a_b.c.*',
    'module-no-dep: :a/b -> :c',
  ])]);
  assert.equal(odd.errors.length, 1, 'module globs carry no "/"');
  const ref = new Set([...shapes(generateFitness(one, modules)['architecture-fitness.gradle.kts']), ...shapes(generateFitness(one, modules)['ArchitectureFitnessTest.kt'])]);
  for (const name of ['architecture-fitness.gradle.kts', 'ArchitectureFitnessTest.kt']) {
    for (const s of shapes(generateFitness(odd.rules, modules)[name])) assert.ok(ref.has(s), `${name}: new shape ${s}`);
  }
});

test('kotlinString validates then escapes', () => {
  assert.equal(kotlinString(':feature:*'), '":feature:*"');
  for (const bad of ['a"b', 'a$b', 'a\nb', 'a\\b', '', 'a b', 'a\u2028']) assert.throws(() => kotlinString(bad), JSON.stringify(bad));
});

const discoverFixture = () => discoverModules(FIXTURE, listFiles(FIXTURE));

// ---------- CLI ----------

test('CLI --check: JSON on stdout, exit 1 on violations and 0 when clean', () => {
  const dir = project();
  try {
    const r = cli([dir, '--check']);
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.violations.length, 1);
    assert.equal(out.violations[0].file, 'feature/a/build.gradle');
    const build = path.join(dir, 'feature/a/build.gradle');
    fs.writeFileSync(build, fs.readFileSync(build, 'utf8').replace("    implementation project(':feature:b')\n", ''));
    const clean = cli([dir, '--check']);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(JSON.parse(clean.stdout).ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.ai/fitness')), false, '--check writes nothing');
  } finally {
    cleanup(dir);
  }
});

test('CLI: rule errors exit 1 with the rule-prefixed message and write nothing', () => {
  const dir = project({ '0001-bad.md': adrText('accepted', ['module-no-dep: :a:password=hunter2hunter2 -> :b']) });
  try {
    for (const args of [[dir], [dir, '--check']]) {
      const r = cli(args);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /0001-bad\.md: rule "1": /);
      assert.ok(!r.stderr.includes('hunter2') && !r.stdout.includes('hunter2'));
    }
    assert.equal(fs.existsSync(path.join(dir, '.ai/fitness')), false);
  } finally {
    cleanup(dir);
  }
});

test('CLI: a proposed ADR gives a note and no rules', () => {
  const dir = project({ '0001-p.md': adrText('proposed', [MODULE_RULE]) });
  try {
    const r = cli([dir, '--check']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.rules, 0);
    assert.ok(out.notes.some((n) => n.startsWith('0001-p.md: ')));
  } finally {
    cleanup(dir);
  }
});

test('CLI default mode writes only under .ai/fitness through the guarded writer', () => {
  const dir = project();
  try {
    const r = cli([dir]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.rules.length, 1);
    assert.deepEqual(out.written, [
      '.ai/fitness/ArchitectureFitnessTest.kt', '.ai/fitness/README.md', '.ai/fitness/architecture-fitness.gradle.kts', '.ai/fitness/verify-commands.json',
    ]);
    const all = listFiles(dir).filter((f) => !f.startsWith('.ai/'));
    assert.equal(all.length, listFiles(FIXTURE).length, 'nothing written outside .ai');
    assert.deepEqual(fs.readdirSync(path.join(dir, '.ai')).sort(), ['fitness', 'knowledge']);
    assert.deepEqual(scanAiDir(dir), []);
  } finally {
    cleanup(dir);
  }
});

test('CLI refuses a symlinked .ai/fitness and leaves its target untouched', () => {
  const dir = project();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fitness-target-'));
  try {
    fs.symlinkSync(elsewhere, path.join(dir, '.ai/fitness'));
    const r = cli([dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /symlink/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    assert.equal(scanAiDir(dir).some((f) => f.rule === 'symlink'), true);
  } finally {
    cleanup(dir);
    cleanup(elsewhere);
  }
});

test('CLI exit 2 without .ai or outside a Gradle project; usage errors exit 1', () => {
  const dir = project({}, { ai: false });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fitness-empty-'));
  try {
    const r = cli([dir]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /init/);
    assert.equal(cli([empty, '--check']).status, 2);
    assert.equal(cli([]).status, 1);
    assert.equal(cli([dir, '--bogus']).status, 1);
  } finally {
    cleanup(dir);
    cleanup(empty);
  }
});

test('CLI --out writes the files outside the project only', () => {
  const dir = project();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fitness-out-'));
  try {
    const r = cli([dir, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(out, 'architecture-fitness.gradle.kts')));
    assert.equal(fs.existsSync(path.join(dir, '.ai/fitness')), false);
    assert.equal(cli([dir, '--out', path.join(dir, 'x')]).status, 1);
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test('references/fitness.md documents the grammar and scans clean', () => {
  const text = fs.readFileSync(path.join(SKILL, 'references/fitness.md'), 'utf8');
  assert.deepEqual(scanInstructions(text), []);
  for (const w of ['module-no-dep', 'package-no-import', 'detekt', 'Konsist', 'architectureFitness', 'accepted', 'review']) assert.ok(text.includes(w), w);
});

test('init and refresh leave .ai/fitness alone', () => {
  const dir = project();
  const run = (script, args) => spawnSync(process.execPath, ['--import', HELPER, path.join(SKILL, 'scripts', script), ...args], { encoding: 'utf8' });
  try {
    assert.equal(run('init-ai.js', [dir]).status, 0);
    assert.equal(cli([dir]).status, 0);
    const before = fs.readdirSync(path.join(dir, '.ai/fitness')).map((n) => [n, fs.readFileSync(path.join(dir, '.ai/fitness', n), 'utf8')]);
    assert.equal(run('refresh.js', [dir]).status, 0);
    assert.equal(run('init-ai.js', [dir]).status, 0);
    const after = fs.readdirSync(path.join(dir, '.ai/fitness')).map((n) => [n, fs.readFileSync(path.join(dir, '.ai/fitness', n), 'utf8')]);
    assert.deepEqual(after, before);
  } finally {
    cleanup(dir);
  }
});

test('CLI --out refuses a pre-planted hardlink to a project file, writes nothing and leaks no path', () => {
  const dir = project();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fitness-out-'));
  try {
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'keep');
    fs.linkSync(victim, path.join(out, 'verify-commands.json'));
    const r = cli([dir, '--out', out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing to write verify-commands\.json in --out: must not be a hard-linked file/);
    assert.ok(!r.stderr.includes(dir) && !r.stderr.includes(out), 'no absolute path');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(out), ['verify-commands.json'], 'no other file written');
    // a symlinked target is refused too
    fs.rmSync(path.join(out, 'verify-commands.json'));
    fs.symlinkSync(victim, path.join(out, 'README.md'));
    const r2 = cli([dir, '--out', out]);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /symbolic link/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(out), ['README.md']);
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test('CLI --out refuses a symlinked directory and gives a clean message when it cannot be created', () => {
  const dir = project();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fitness-out-'));
  try {
    fs.writeFileSync(path.join(out, 'afile'), 'x');
    const r = cli([dir, '--out', path.join(out, 'afile', 'sub')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot create --out directory/);
    assert.ok(!r.stderr.includes(out), 'no absolute path');
    fs.mkdirSync(path.join(out, 'real'));
    fs.symlinkSync(path.join(out, 'real'), path.join(out, 'link'));
    const r2 = cli([dir, '--out', path.join(out, 'link')]);
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /symlink/);
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});
