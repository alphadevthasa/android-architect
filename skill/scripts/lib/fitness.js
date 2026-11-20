// Architecture fitness rules from accepted ADRs: parsing, a static check, and generated Gradle/Konsist sources.
// ADR text and module paths come from the project, so they are untrusted: every rule is validated against a tiny
// grammar before use, matching is linear (no RegExp is ever built from project text), and every value emitted into
// generated code passes kotlinString(), which refuses anything outside a small character set.
import fs from 'node:fs';
import path from 'node:path';
import { matchGlob } from './overrides.js';
import { discoverModules } from './modules.js';
import { listFiles } from './walk.js';
import { redact } from './redact.js';

export const MAX_RULES_PER_ADR = 20;
export const MAX_RULE_LENGTH = 200;
const MAX_SOURCE_BYTES = 1024 * 1024;
const SEPARATOR = ' -> ';
const KINDS = ['module-no-dep', 'package-no-import'];

// The only characters a value may carry into generated code (the rule values and module paths).
const EMITTABLE = /^[A-Za-z0-9_.:\-/*]+$/;
const MODULE_GLOB = /^:[A-Za-z0-9_.\-*:]+$/;
const PACKAGE_GLOB = /^[A-Za-z0-9_.*]+$/;
const IMPORT_PREFIX = /^[A-Za-z_][A-Za-z0-9_.]*(?:\.\*)?$/;
const MODULE_PATH = /^:(?:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)?$/;
const MODULE_DIR = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
// Fixed, anchored line patterns; the name spans are single character classes, so matching stays linear.
const PACKAGE_LINE = /^\s*package\s+([A-Za-z_`][\w.`]*)/;
const IMPORT_LINE = /^\s*import\s+(?:static\s+)?([A-Za-z_`][\w.`]*\*?)/;
// A package name: dot-separated identifiers, no empty segment (so "com.example." never matches "com.example.*").
const PACKAGE_NAME = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A label for comments, ids and messages: only [A-Za-z0-9_.-] (plus `extra`), at most `max` characters. */
export function safeLabel(value, max = 80, extra = '') {
  let out = '';
  for (const ch of String(value).slice(0, max)) {
    out += /[A-Za-z0-9_.-]/.test(ch) || extra.includes(ch) ? ch : '-';
  }
  return out === '' ? 'unnamed' : out;
}

/** Shows a project file path in output: characters outside printable ASCII become \u{..} text. */
function displayPath(p) {
  let out = '';
  for (const ch of String(p)) {
    const c = ch.codePointAt(0);
    out += c >= 0x20 && c <= 0x7e ? ch : `\\u{${c.toString(16)}}`;
  }
  return out;
}

/**
 * The one escaper for string literals in generated Kotlin and Gradle Kotlin DSL. It first refuses any value outside
 * A-Za-z0-9 _ . : - / * (so quotes, "$", backslashes, whitespace and line breaks never reach generated code), then
 * escapes \ " $ and line breaks anyway, as a second line of defense.
 */
export function kotlinString(value) {
  if (typeof value !== 'string' || !EMITTABLE.test(value)) {
    throw new Error('refusing to emit a value outside A-Za-z0-9 _ . : - / * into generated code');
  }
  const map = { '\\': '\\\\', '"': '\\"', $: '\\$', '\n': '\\n', '\r': '\\r' };
  let out = '';
  for (const ch of value) out += map[ch] ?? ch;
  return `"${out}"`;
}

/** Segment shape shared by module (":"-separated) and package ("."-separated) globs; null when fine. */
function shapeProblem(segs) {
  const lead = segs.length > 1 && segs[0] === '**';
  const trail = segs.length > 1 && segs[segs.length - 1] === '**';
  if (lead && trail) return '"**" may be used only once, as the whole first or last segment';
  const core = segs.slice(lead ? 1 : 0, trail ? segs.length - 1 : segs.length);
  let stars = lead || trail ? 1 : 0;
  for (const s of core) {
    if (s === '') return 'has an empty segment';
    if (s.includes('**')) return '"**" may be used only as the whole first or last segment';
    const n = s.split('*').length - 1;
    if (n > 1) return 'may use at most one "*" per segment';
    stars += n;
  }
  if (stars > 2) return 'may use at most 2 "*" in total';
  return null;
}

function moduleGlobProblem(g) {
  if (!g.startsWith(':')) return 'a module glob must start with ":"';
  if (!MODULE_GLOB.test(g)) return 'a module glob may use only letters, digits, _ . - * and :';
  const p = shapeProblem(g.slice(1).split(':'));
  return p ? `the module glob ${p}` : null;
}

function packageGlobProblem(g) {
  if (!PACKAGE_GLOB.test(g)) return 'a package glob may use only letters, digits, _ . and *';
  const p = shapeProblem(g.split('.'));
  return p ? `the package glob ${p}` : null;
}

function importPrefixProblem(p) {
  if (!IMPORT_PREFIX.test(p) || p.includes('..')) {
    return 'an import prefix is a literal name prefix (letters, digits, _ and .), optionally ending in ".*"';
  }
  return null;
}

/** Parses one rule string into { kind, from, to }; throws an Error whose message never repeats the value. */
function parseRule(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('is empty');
  if (text.length > MAX_RULE_LENGTH) throw new Error(`is longer than ${MAX_RULE_LENGTH} characters`);
  const colon = text.indexOf(': ');
  const kind = colon === -1 ? '' : text.slice(0, colon);
  if (!KINDS.includes(kind)) throw new Error(`must start with ${KINDS.map((k) => `"${k}: "`).join(' or ')}`);
  const rest = text.slice(colon + 2);
  const at = rest.indexOf(SEPARATOR);
  if (at === -1) throw new Error(`expected "<from>${SEPARATOR}<to>"`);
  if (rest.indexOf(SEPARATOR, at + 1) !== -1) throw new Error(`has more than one "${SEPARATOR.trim()}"`);
  const from = rest.slice(0, at);
  const to = rest.slice(at + SEPARATOR.length);
  for (const v of [from, to]) {
    if (!EMITTABLE.test(v)) throw new Error('a value contains a character outside A-Za-z0-9 _ . : - / * (spaces, quotes, "$" and line breaks are not allowed)');
  }
  const problem = kind === 'module-no-dep'
    ? moduleGlobProblem(from) ?? moduleGlobProblem(to)
    : packageGlobProblem(from) ?? importPrefixProblem(to);
  if (problem) throw new Error(problem);
  if (redact(text).text !== text) throw new Error('looks like it contains a secret');
  return { kind, from, to };
}

/**
 * Rules from the `fitness` key of ADRs. Only accepted ADRs contribute; an ADR in another status that has rules yields a
 * note. Every invalid rule yields an error `<adr file>: rule "<n>": <reason>` (n is 1-based); an ADR with more than
 * MAX_RULES_PER_ADR rules contributes none. Returns { rules: [{ id, adr, kind, from, to }], errors, notes }.
 */
export function parseFitnessRules(adrs) {
  const rules = [];
  const errors = [];
  const notes = [];
  const ids = new Set();
  for (const adr of adrs) {
    const list = Array.isArray(adr?.fitness) ? adr.fitness : [];
    if (list.length === 0) continue;
    const file = safeLabel(adr.file);
    if (adr.status !== 'accepted') {
      notes.push(`${file}: ${plural(list.length, 'fitness rule')} ignored: status is ${safeLabel(adr.status, 20)}, only accepted ADRs contribute rules`);
      continue;
    }
    if (list.length > MAX_RULES_PER_ADR) {
      errors.push(`${file}: rule "${MAX_RULES_PER_ADR + 1}": more than ${MAX_RULES_PER_ADR} rules in one ADR (${list.length}); no rule of this ADR is used`);
      continue;
    }
    const stem = safeLabel(String(adr.file).replace(/\.md$/, ''), 60);
    list.forEach((text, i) => {
      try {
        const rule = parseRule(text);
        let id = `${stem}-r${i + 1}`;
        for (let k = 2; ids.has(id); k++) id = `${stem}-r${i + 1}-${k}`;
        ids.add(id);
        rules.push({ id, adr: file, ...rule });
      } catch (err) {
        errors.push(`${file}: rule "${i + 1}": ${err.message}`);
      }
    });
  }
  return { rules, errors, notes };
}

/** Module glob match: ":"-separated segments; the root module ":" never matches. */
export function matchModuleGlob(pattern, modulePath) {
  if (!pattern.startsWith(':') || !modulePath.startsWith(':') || modulePath === ':') return false;
  return matchGlob(pattern.slice(1), modulePath.slice(1), { sep: ':' });
}

/** Package glob match: "."-separated segments; the default (empty) package and malformed names never match. */
export function matchPackageGlob(pattern, packageName) {
  if (!PACKAGE_NAME.test(packageName)) return false;
  return matchGlob(pattern, packageName, { sep: '.' });
}

const importPrefix = (to) => (to.endsWith('*') ? to.slice(0, -1) : to);

/**
 * The modules whose path and directory use only safe characters (they may appear in generated code); every other
 * module is skipped with a note that names it only by a sanitized label. Returns { modules, notes }.
 */
export function validModules(modules) {
  const valid = [];
  const notes = [];
  for (const m of modules ?? []) {
    const dir = String(m?.dir ?? '');
    const dirOk = dir === '' || (MODULE_DIR.test(dir) && !dir.split('/').some((s) => s === '.' || s === '..'));
    if (typeof m?.path === 'string' && MODULE_PATH.test(m.path) && dirOk) valid.push(m);
    else notes.push(`module ${safeLabel(m?.path, 80, ':')} skipped: its path or directory uses characters outside A-Za-z0-9 _ . - (with : or /)`);
  }
  return { modules: valid, notes };
}

const normalizeProject = (p) => {
  const t = String(p).trim();
  return t.startsWith(':') ? t : `:${t}`;
};

/**
 * The text of one line outside block comments, triple-quoted strings, string and char literals and line comments
 * (each replaced by a space). `state` carries an open block comment or triple-quoted string to the next line. Linear.
 */
function visibleText(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.block) {
      const end = line.indexOf('*/', i);
      if (end === -1) return out;
      state.block = false;
      i = end + 2;
      out += ' ';
    } else if (state.raw) {
      const end = line.indexOf('"""', i);
      if (end === -1) return out;
      state.raw = false;
      i = end + 3;
      out += ' ';
    } else if (line.startsWith('/*', i)) {
      state.block = true;
      i += 2;
    } else if (line.startsWith('//', i)) {
      return out;
    } else if (line.startsWith('"""', i)) {
      state.raw = true;
      i += 3;
    } else if (line[i] === '"' || line[i] === "'") {
      const q = line[i];
      i++;
      while (i < line.length && line[i] !== q) i += line[i] === '\\' ? 2 : 1;
      i++;
      out += ' ';
    } else {
      out += line[i++];
    }
  }
  return out;
}

/** package and import lines of a Kotlin/Java source, line by line, outside comments and strings: { pkg, imports }. */
function sourceNames(text) {
  let pkg = '';
  const imports = [];
  const state = { block: false, raw: false };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = state.block || state.raw || raw.includes('/*') || raw.includes('"') || raw.includes("'") || raw.includes('//')
      ? visibleText(raw, state)
      : raw;
    if (pkg === '' && line.includes('package')) {
      const m = PACKAGE_LINE.exec(line);
      if (m) pkg = m[1].replaceAll('`', '');
    }
    if (line.includes('import')) {
      const m = IMPORT_LINE.exec(line);
      if (m) imports.push({ name: m[1].replaceAll('`', ''), line: i + 1 });
    }
  }
  return { pkg, imports };
}

/** The first MAX_SOURCE_BYTES of a file as UTF-8, and whether it was cut. */
function readHead(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const cut = n > MAX_SOURCE_BYTES;
    return { text: buf.subarray(0, Math.min(n, MAX_SOURCE_BYTES)).toString('utf8'), cut };
  } finally {
    fs.closeSync(fd);
  }
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Static evaluation of the rules: module rules against the declared project dependencies of every module (evidence: the
 * build file and line of the `project(...)` dependency), package rules against the package and import lines of the
 * Kotlin/Java sources (git-ignored files dropped; only the first 1 MB of a larger file is read, counted in
 * `truncatedFiles`; unreadable and non-regular files are counted in `skippedFiles`).
 * `opts.files` / `opts.modules` reuse an existing listing. Returns { ok, violations: [{ rule, from, to, file, line }],
 * notes, skippedFiles, truncatedFiles }.
 */
export function checkFitness(root, rules, opts = {}) {
  const needFiles = opts.files === undefined && (opts.modules === undefined || rules.some((r) => r.kind === 'package-no-import'));
  const files = opts.files ?? (needFiles ? listFiles(root, { gitignore: true }) : []);
  const { modules, notes } = validModules(opts.modules ?? discoverModules(root, files));
  const violations = [];

  const moduleRules = rules.filter((r) => r.kind === 'module-no-dep');
  let badDeps = 0;
  if (moduleRules.length) {
    for (const m of modules) {
      for (const dep of m.build?.dependencies ?? []) {
        if (!dep.project) continue;
        const to = normalizeProject(dep.project);
        if (!MODULE_PATH.test(to)) { badDeps++; continue; }
        if (to === m.path) continue;
        for (const r of moduleRules) {
          if (matchModuleGlob(r.from, m.path) && matchModuleGlob(r.to, to)) {
            violations.push({ rule: r.id, from: m.path, to, file: displayPath(m.buildFile), line: dep.line ?? null });
          }
        }
      }
    }
  }
  if (badDeps) notes.push(`${badDeps} project ${badDeps === 1 ? 'dependency' : 'dependencies'} with unsafe characters in the path not checked`);

  const packageRules = rules.filter((r) => r.kind === 'package-no-import');
  let skippedFiles = 0;
  let truncatedFiles = 0;
  if (packageRules.length) {
    for (const rel of files) {
      if (!rel.endsWith('.kt') && !rel.endsWith('.java')) continue;
      let text;
      try {
        const abs = path.join(root, rel);
        if (!fs.statSync(abs).isFile()) { skippedFiles++; continue; }
        const head = readHead(abs);
        if (head.cut) truncatedFiles++;
        text = head.text;
      } catch {
        skippedFiles++;
        continue;
      }
      const { pkg, imports } = sourceNames(text);
      for (const r of packageRules) {
        if (!matchPackageGlob(r.from, pkg)) continue;
        const prefix = importPrefix(r.to);
        for (const imp of imports) {
          if (imp.name.startsWith(prefix)) violations.push({ rule: r.id, from: pkg, to: imp.name, file: displayPath(rel), line: imp.line });
        }
      }
    }
  }
  if (skippedFiles) notes.push(`${plural(skippedFiles, 'source file')} unreadable, not checked for package rules`);
  if (truncatedFiles) notes.push(`${plural(truncatedFiles, 'source file')} over 1 MB: only the first 1 MB checked for package rules`);

  violations.sort((a, b) => byText(a.rule, b.rule) || byText(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || byText(a.to, b.to));
  return { ok: violations.length === 0, violations, notes, skippedFiles, truncatedFiles };
}

// ---------- generated sources ----------

const HEADER = [
  '// Generated by android-architect (fitness.js) from the fitness rules of accepted ADRs in .ai/knowledge/adr.',
  '// Review this file before use: it is never applied automatically. Regenerate it instead of editing it here.',
];

const ruleComment = (r, prefix = '') => `// ${prefix}${safeLabel(r.id)} (${r.kind}) from ADR ${safeLabel(r.adr)}`;

function gradleScript(rules) {
  const mod = rules.filter((r) => r.kind === 'module-no-dep');
  return [
    ...HEADER,
    '//',
    '// Root-project script with one task, architectureFitness. Apply it from the root build.gradle.kts with',
    '//     apply(from = ".ai/fitness/architecture-fitness.gradle.kts")',
    '// or copy it into the project first (for example gradle/architecture-fitness.gradle.kts) and apply the copy.',
    '// The task only reads the declared project dependencies of every project. It starts no process and reads no',
    '// network.',
    '// Requires Gradle 8.11 or newer: it reads ProjectDependency.path (check the Gradle docs for your version). The',
    '// task does not support the configuration cache, because it reads other projects when it runs. The check task',
    '// depends on it when the root project applies the base plugin (directly or through another plugin).',
    '//',
    '// Rules:',
    ...(mod.length ? mod.map((r) => ruleComment(r, '  ')) : ['//   none (no accepted ADR has a module-no-dep rule)']),
    '',
    '// Each rule: id, module glob of the depending module, module glob of the forbidden dependency.',
    'val architectureFitnessModuleRules: List<List<String>> = listOf(',
    ...mod.map((r) => `    listOf(${kotlinString(r.id)}, ${kotlinString(r.from)}, ${kotlinString(r.to)}),`),
    ')',
    '',
    'fun architectureFitnessSegmentMatches(pattern: String, text: String): Boolean {',
    '    val star = pattern.indexOf("*")',
    '    if (star < 0) return pattern == text',
    '    val prefix = pattern.substring(0, star)',
    '    val suffix = pattern.substring(star + 1)',
    '    return text.length >= prefix.length + suffix.length && text.startsWith(prefix) && text.endsWith(suffix)',
    '}',
    '',
    '// Module globs: ":"-separated segments, at most one "*" per segment, "**" only as the whole first or last segment.',
    'fun architectureFitnessMatches(pattern: String, modulePath: String): Boolean {',
    '    if (!pattern.startsWith(":") || !modulePath.startsWith(":") || modulePath == ":") return false',
    '    val p = pattern.substring(1).split(":")',
    '    val t = modulePath.substring(1).split(":")',
    '    val lead = p.size > 1 && p.first() == "**"',
    '    val trail = !lead && p.size > 1 && p.last() == "**"',
    '    val core = p.subList(if (lead) 1 else 0, if (trail) p.size - 1 else p.size)',
    '    if (lead && t.size < core.size) return false',
    '    if (trail && t.size <= core.size) return false',
    '    if (!lead && !trail && t.size != core.size) return false',
    '    val offset = if (lead) t.size - core.size else 0',
    '    return core.indices.all { architectureFitnessSegmentMatches(core[it], t[offset + it]) }',
    '}',
    '',
    'val architectureFitness = tasks.register("architectureFitness") {',
    '    group = "verification"',
    '    description = "Fails when a project dependency breaks a fitness rule of an accepted ADR."',
    '    notCompatibleWithConfigurationCache("Reads the declared dependencies of every project when the task runs.")',
    '    doLast {',
    '        val violations = mutableListOf<String>()',
    '        for (candidate in rootProject.allprojects) {',
    '            for (configuration in candidate.configurations) {',
    '                for (dependency in configuration.dependencies.withType(ProjectDependency::class.java)) {',
    '                    val target = dependency.path',
    '                    for (rule in architectureFitnessModuleRules) {',
    '                        if (candidate.path != target && architectureFitnessMatches(rule[1], candidate.path) && architectureFitnessMatches(rule[2], target)) {',
    '                            val line = "rule " + rule[0] + ": " + candidate.path + " depends on " + target + " (" + configuration.name + ")"',
    '                            if (line !in violations) violations.add(line)',
    '                        }',
    '                    }',
    '                }',
    '            }',
    '        }',
    '        if (violations.isNotEmpty()) {',
    '            throw GradleException("Architecture fitness check failed:\\n" + violations.joinToString("\\n"))',
    '        }',
    '    }',
    '}',
    '',
    'plugins.withId("base") {',
    '    tasks.named("check") {',
    '        dependsOn(architectureFitness)',
    '    }',
    '}',
    '',
  ].join('\n');
}

const dirList = (dirs) => ['listOf<String>(', ...dirs.map((d) => `            ${kotlinString(d)},`), '        )'];

function packageTest(r, n) {
  return [
    `    ${ruleComment(r)}`,
    '    @Test',
    `    fun fitnessRule${n}() {`,
    `        val ruleId = ${kotlinString(r.id)}`,
    `        val packageGlob = ${kotlinString(r.from)}`,
    `        val importPrefix = ${kotlinString(importPrefix(r.to))}`,
    '        val violations = mutableListOf<String>()',
    '        for (file in Konsist.scopeFromProject().files) {',
    '            val packageName = file.packagee?.name ?: ""',
    '            if (!fitnessPackageMatches(packageGlob, packageName)) continue',
    '            for (imported in file.imports) {',
    '                if (imported.name.startsWith(importPrefix)) violations.add(file.path + ": " + imported.name)',
    '            }',
    '        }',
    '        check(violations.isEmpty()) { "Fitness rule " + ruleId + " failed:\\n" + violations.joinToString("\\n") }',
    '    }',
  ];
}

function moduleTest(r, n, modules) {
  const dirsOf = (glob) => modules.filter((m) => m.path !== ':' && matchModuleGlob(glob, m.path)).map((m) => m.dir);
  const [first, ...more] = dirList(dirsOf(r.from));
  const [tFirst, ...tMore] = dirList(dirsOf(r.to));
  return [
    `    ${ruleComment(r)}`,
    '    @Test',
    `    fun fitnessRule${n}() {`,
    `        val ruleId = ${kotlinString(r.id)}`,
    `        val fromDirs = ${first}`,
    ...more,
    `        val toDirs = ${tFirst}`,
    ...tMore,
    '        val violations = mutableListOf<String>()',
    '        for (fromDir in fromDirs) {',
    '            val fromFiles = Konsist.scopeFromModule(fromDir).files',
    '            val ownPackages = fromFiles.mapNotNull { it.packagee?.name }.toSet()',
    '            val forbidden = toDirs.filter { it != fromDir }',
    '                .flatMap { dir -> Konsist.scopeFromModule(dir).files.mapNotNull { it.packagee?.name } }',
    '                .toSet() - ownPackages',
    '            for (file in fromFiles) {',
    '                for (imported in file.imports) {',
    '                    if (imported.name.substringBeforeLast(".") in forbidden) violations.add(fromDir + ": " + file.path + ": " + imported.name)',
    '                }',
    '            }',
    '        }',
    '        check(violations.isEmpty()) { "Fitness rule " + ruleId + " failed:\\n" + violations.joinToString("\\n") }',
    '    }',
  ];
}

function konsistTest(rules, modules) {
  const tests = rules.flatMap((r, i) => [
    ...(i ? [''] : []),
    ...(r.kind === 'package-no-import' ? packageTest(r, i + 1) : moduleTest(r, i + 1, modules)),
  ]);
  return [
    ...HEADER,
    '//',
    '// Konsist test for the fitness rules. After review, copy it into a unit test source set (for example',
    '// app/src/test/kotlin/architecture/ArchitectureFitnessTest.kt), add a package line that matches that folder, and add',
    '// the Konsist test dependency (com.lemonappdev:konsist) to that module.',
    '// Verify against the Konsist version you use: the file uses only Konsist.scopeFromProject, Konsist.scopeFromModule,',
    '// the files of a scope and the file properties packagee, imports and path. scopeFromModule receives the module',
    '// directory relative to the project root. The module lists come from the Gradle settings at generation time;',
    '// regenerate the file when modules change. Module rules compare the imports of a module with the packages declared',
    '// in the forbidden modules.',
    '//',
    '// Rules:',
    ...(rules.length ? rules.map((r, i) => ruleComment(r, `  fitnessRule${i + 1}: `)) : ['//   none (no accepted ADR has a fitness rule)']),
    '',
    'import com.lemonappdev.konsist.api.Konsist',
    'import org.junit.Test',
    '',
    'class ArchitectureFitnessTest {',
    ...tests,
    '}',
    '',
    'private fun fitnessSegmentMatches(pattern: String, text: String): Boolean {',
    '    val star = pattern.indexOf("*")',
    '    if (star < 0) return pattern == text',
    '    val prefix = pattern.substring(0, star)',
    '    val suffix = pattern.substring(star + 1)',
    '    return text.length >= prefix.length + suffix.length && text.startsWith(prefix) && text.endsWith(suffix)',
    '}',
    '',
    '// Package globs: "."-separated segments, at most one "*" per segment, "**" only as the whole first or last segment.',
    'private fun fitnessPackageMatches(pattern: String, packageName: String): Boolean {',
    '    if (packageName.isEmpty()) return false',
    '    val p = pattern.split(".")',
    '    val t = packageName.split(".")',
    '    val lead = p.size > 1 && p.first() == "**"',
    '    val trail = !lead && p.size > 1 && p.last() == "**"',
    '    val core = p.subList(if (lead) 1 else 0, if (trail) p.size - 1 else p.size)',
    '    if (lead && t.size < core.size) return false',
    '    if (trail && t.size <= core.size) return false',
    '    if (!lead && !trail && t.size != core.size) return false',
    '    val offset = if (lead) t.size - core.size else 0',
    '    return core.indices.all { fitnessSegmentMatches(core[it], t[offset + it]) }',
    '}',
    '',
  ].join('\n');
}

function readme(rules, skipped, names) {
  const code = (v) => `\`${v}\``;
  const gradle = names.includes('architecture-fitness.gradle.kts');
  const konsist = names.includes('ArchitectureFitnessTest.kt');
  return [
    '<!-- Generated by android-architect (fitness.js) from accepted ADRs. Rewritten on every fitness.js run: change the ADRs, not this file. -->',
    '# Architecture fitness checks',
    '',
    'These files encode the `fitness` rules of the accepted ADRs in `.ai/knowledge/adr`. They are proposals for the build:',
    'review them, then copy or apply them yourself. Nothing in this folder is applied to the project automatically.',
    'Regenerate them with fitness.js instead of editing them.',
    '',
    '## Rules',
    '',
    ...(rules.length
      ? ['| Rule | ADR | Kind | From | To |', '|---|---|---|---|---|',
        ...rules.map((r) => `| ${code(safeLabel(r.id))} | ${code(safeLabel(r.adr))} | ${r.kind} | ${code(r.from)} | ${code(r.to)} |`)]
      : ['No accepted ADR has a `fitness` key, so no Gradle script and no Konsist test were generated.']),
    '',
    ...(skipped
      ? [`${skipped} ${skipped === 1 ? 'module was' : 'modules were'} skipped because the module path or directory uses characters outside the safe set; they appear in no generated file.`, '']
      : []),
    '## Files',
    '',
    ...(gradle
      ? ['- `architecture-fitness.gradle.kts`: a root-project Gradle script with the `architectureFitness` task (Gradle 8.11 or newer). It fails the build with one line per forbidden project dependency, and `check` depends on it when the root project applies the `base` plugin.']
      : ['- No Gradle script: it is generated only when an accepted ADR has a `module-no-dep` rule.']),
    ...(konsist
      ? ['- `ArchitectureFitnessTest.kt`: a Konsist unit test for the package rules and, through the imports of each module, the module rules.']
      : []),
    gradle || konsist
      ? '- `verify-commands.json`: the verification commands for the generated checks, used by the agent loop.'
      : '- `verify-commands.json`: an empty command list, because no check was generated.',
    '',
    ...(gradle || konsist
      ? [
        '## Applying them',
        '',
        '1. Review every file. They change what the build checks, so they go through the normal code review.',
        ...(gradle
          ? ['1. Gradle task: add this line to the root `build.gradle.kts` (or copy the script into the project and apply the copy):', '',
            '   ```kotlin', '   apply(from = ".ai/fitness/architecture-fitness.gradle.kts")', '   ```', '']
          : []),
        ...(konsist ? ['1. Konsist test: copy `ArchitectureFitnessTest.kt` into a unit test source set, add a matching package line and the Konsist test dependency.'] : []),
        '1. Regenerate these files with fitness.js after changing a fitness rule or the module list, then review and copy them again.',
        '',
      ]
      : []),
  ].join('\n');
}

// Fixed strings only: one per generated check, listed only when that check was generated.
const GRADLE_COMMAND = './gradlew architectureFitness';
const KONSIST_COMMAND = "./gradlew testDebugUnitTest --tests '*ArchitectureFitnessTest'";

/** Every file name generateFitness can produce; a run removes the ones it does not produce this time. */
export const FITNESS_FILES = ['architecture-fitness.gradle.kts', 'ArchitectureFitnessTest.kt', 'verify-commands.json', 'README.md'];

/**
 * Generated files for .ai/fitness (paths relative to that folder): the Gradle script (only with module rules), the
 * Konsist test (only with rules), verify-commands.json (the commands of the generated checks; an empty list when none
 * was generated) and a README. Rules must come from parseFitnessRules; modules whose path or directory fails
 * validModules are left out (the README counts them). Throws when redaction would change a generated file, so a
 * secret-looking module directory never reaches generated code.
 */
export function generateFitness(rules, modules = []) {
  const { modules: safe, notes } = validModules(modules);
  const files = {};
  // A script without module rules checks nothing, and a JUnit class without tests fails ("No runnable methods").
  if (rules.some((r) => r.kind === 'module-no-dep')) files['architecture-fitness.gradle.kts'] = gradleScript(rules);
  if (rules.length) files['ArchitectureFitnessTest.kt'] = konsistTest(rules, safe);
  const commands = [
    ...('architecture-fitness.gradle.kts' in files ? [GRADLE_COMMAND] : []),
    ...('ArchitectureFitnessTest.kt' in files ? [KONSIST_COMMAND] : []),
  ];
  files['verify-commands.json'] = JSON.stringify({ schemaVersion: 1, commands }, null, 2) + '\n';
  files['README.md'] = readme(rules, notes.length, Object.keys(files));
  for (const text of Object.values(files)) {
    if (redact(text).text !== text) throw new Error('a generated fitness file would be changed by secret redaction; check the module names');
  }
  return files;
}
