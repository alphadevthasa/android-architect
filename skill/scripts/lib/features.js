import fs from 'node:fs';
import path from 'node:path';
import { listFiles, readLines } from './walk.js';
import { FEATURE_SEGMENT, moduleSegments } from './detect.js';

const MAX_READ_BYTES = 1024 * 1024;
const MIN_PACKAGE_FILES = 3;
const BULK_COMMIT_FILES = 50; // commits touching more files are bulk reformat/rename: ignored for churn
const BYTES_PER_LOC = 40; // LOC estimate for files over MAX_READ_BYTES
const MAX_NAME = 60;
const IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.]+)/;
const FEATURE_PKG = /^features?$/;
const STATE_FLOW = new Set([
  'kotlinx.coroutines.flow.StateFlow',
  'kotlinx.coroutines.flow.MutableStateFlow',
  'kotlinx.coroutines.flow.asStateFlow',
  'kotlinx.coroutines.flow.stateIn',
]);
const BUCKET_ORDER = { first: 0, next: 1, last: 2 };
const BAND_LABEL = ['small', 'medium', 'large'];

const extOf = (rel) => path.posix.extname(rel).toLowerCase();
const isSource = (rel) => extOf(rel) === '.kt' || extOf(rel) === '.java';
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Feature units and the heuristics that score them.
 *
 * Units, in order of preference:
 *   1. feature modules: a Gradle module path segment matching /^features?([-_].+)?$/; the name is the part after
 *      `feature-`/`feature_`, or the next segment (`:feature:login` -> login). Modules with the same name merge.
 *   2. feature packages: a `feature(s)/<name>` directory under a source root (src/<set>/java|kotlin/**).
 *   3. fallback 'packages': first-level packages below the packages shared by all main sources, with >= 3 source files.
 *   4. fallback 'app': one unit holding the whole project.
 *
 * Proximity (0..1) = modern UI files / (modern + legacy UI files), per main-source file:
 *   - modern: a Kotlin/Java file importing androidx.compose.*, or importing both androidx.lifecycle.ViewModel and a
 *     StateFlow type (StateFlow, MutableStateFlow, asStateFlow, stateIn).
 *   - legacy: a file using findViewById, R.layout., or a databinding/ViewBinding class (Fragment/Activity view code),
 *     and not already modern. Every XML layout (res/layout*) of a module feature is one legacy UI file.
 *   - files that are neither are not UI files and are ignored. No UI files at all gives 0.
 *
 * Scoring (see catalog/scoring.json): each input is normalised to 0..1, higher is a better pilot candidate:
 *   isolation 1/(1+fanIn+fanOut); size by LOC band (<= small 1, <= medium 0.9, <= large 0.4, else 0.1);
 *   tests 0 for none, else min(1, testFiles/2); churn = number of distinct commits (last 6 months) touching the
 *   feature's non-test source or layout files, ignoring commits that touch more than 50 files, divided by the max
 *   over features (higher churn = faster payoff); files over 1 MB are not read: LOC is estimated as bytes / 40;
 *   risk low 1, medium 0.5, high 0 (a penalty); proximity as above.
 * score = 100 * sum(weight * input) / sum(weights used). Without git history the churn weight is dropped and the
 * rest renormalised. A high-risk feature, or one above sizeBands.largeLoc, is capped to `next`.
 */

function srcPath(rel) {
  const s = rel.split('/');
  for (let i = 0; i + 3 < s.length; i++) {
    if (s[i] === 'src' && (s[i + 2] === 'java' || s[i + 2] === 'kotlin')) {
      return { moduleDir: s.slice(0, i).join('/'), set: s[i + 1], pkg: s.slice(i + 3, -1) };
    }
  }
  return null;
}

function layoutPath(rel) {
  const s = rel.split('/');
  if (extOf(rel) !== '.xml' || s.length < 5) return null;
  for (let i = 0; i + 3 < s.length; i++) {
    if (s[i] === 'src' && s[i + 2] === 'res' && s[i + 3].startsWith('layout') && i + 4 === s.length - 1) {
      return { moduleDir: s.slice(0, i).join('/'), set: s[i + 1] };
    }
  }
  return null;
}

const isTestSet = (set) => set.startsWith('test') || set.startsWith('androidTest');
const isTestName = (rel) => /Test\.(kt|java)$/.test(rel);

function makeAnalyzer(root) {
  const cache = new Map();
  return (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let info = { loc: 0, imports: [], modern: false, legacy: false, big: false };
    try {
      const abs = path.join(root, rel);
      const size = fs.statSync(abs).size;
      if (size > MAX_READ_BYTES) {
        info.loc = Math.ceil(size / BYTES_PER_LOC);
        info.big = true;
      } else {
        const lines = readLines(abs);
        let compose = false;
        let viewModel = false;
        let flow = false;
        let legacy = false;
        for (const text of lines) {
          if (text.trim() === '') continue;
          info.loc++;
          const m = IMPORT_RE.exec(text);
          if (m) {
            const imp = m[1];
            info.imports.push(imp);
            if (imp.startsWith('androidx.compose.')) compose = true;
            if (imp === 'androidx.lifecycle.ViewModel' || imp.startsWith('androidx.lifecycle.ViewModel.')) viewModel = true;
            if (STATE_FLOW.has(imp)) flow = true;
            if (imp.includes('.databinding.')) legacy = true;
          } else if (text.includes('findViewById') || text.includes('R.layout.') || text.includes('ViewBinding')) {
            legacy = true;
          }
        }
        info.modern = compose || (viewModel && flow);
        info.legacy = legacy && !info.modern;
      }
    } catch {
      info = { loc: 0, imports: [], modern: false, legacy: false, big: false };
    }
    cache.set(rel, info);
    return info;
  };
}

/** Feature names come from directory names: restrict them to a safe charset. */
export function sanitizeName(raw, index) {
  const clean = String(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, MAX_NAME);
  return clean === '' ? `unit-${index + 1}` : clean;
}

function newUnit(name, kind) {
  return { name, kind, paths: new Set(), prefixes: new Set(), src: new Set(), tests: new Set(), layouts: new Set() };
}

function ownerDir(dirs, file) {
  return dirs.find((d) => d === '' || file.startsWith(d + '/'));
}

function moduleUnits(modules, files) {
  const dirs = [...new Set(['', ...modules.map((m) => m.dir)])].sort((a, b) => b.length - a.length);
  const byDir = new Map();
  for (const m of modules) {
    const segs = moduleSegments(m);
    const i = segs.findIndex((s) => FEATURE_SEGMENT.test(s));
    if (i < 0) continue;
    const tail = FEATURE_SEGMENT.exec(segs[i])[1];
    const name = tail ? tail.slice(1) : segs[i + 1];
    if (!name) continue;
    byDir.set(m.dir, { name, module: m });
  }
  const units = new Map();
  const unitOfModule = new Map();
  for (const [dir, { name, module }] of byDir) {
    if (!units.has(name)) units.set(name, newUnit(name, 'module'));
    const u = units.get(name);
    u.paths.add(dir === '' ? '.' : dir);
    unitOfModule.set(module.path, u);
  }
  for (const f of files) {
    const hit = byDir.get(ownerDir(dirs, f));
    if (!hit) continue;
    const u = units.get(hit.name);
    const sp = srcPath(f);
    const lp = layoutPath(f);
    if (isSource(f)) {
      if ((sp && isTestSet(sp.set)) || isTestName(f)) u.tests.add(f);
      else u.src.add(f);
    } else if (lp && !isTestSet(lp.set)) {
      u.layouts.add(f);
    }
  }
  return { units: [...units.values()], unitOfModule };
}

function packageFeatureUnits(files) {
  const units = new Map();
  for (const f of files) {
    const sp = srcPath(f);
    if (!sp || !isSource(f)) continue;
    const j = sp.pkg.findIndex((s, i) => FEATURE_PKG.test(s) && i + 1 < sp.pkg.length);
    if (j < 0) continue;
    const name = sp.pkg[j + 1];
    if (!units.has(name)) units.set(name, newUnit(name, 'package'));
    const u = units.get(name);
    u.prefixes.add(sp.pkg.slice(0, j + 2).join('.'));
    u.paths.add(f.split('/').slice(0, f.split('/').length - (sp.pkg.length - j - 2) - 1).join('/'));
    if (isTestSet(sp.set) || isTestName(f)) u.tests.add(f);
    else u.src.add(f);
  }
  return [...units.values()];
}

function fallbackPackageUnits(files) {
  const mains = [];
  const tests = [];
  for (const f of files) {
    const sp = srcPath(f);
    if (!sp || !isSource(f)) continue;
    (isTestSet(sp.set) || isTestName(f) ? tests : mains).push({ f, sp });
  }
  if (mains.length === 0) return [];
  let common = mains[0].sp.pkg;
  for (const { sp } of mains) {
    let n = 0;
    while (n < common.length && n < sp.pkg.length && common[n] === sp.pkg[n]) n++;
    common = common.slice(0, n);
  }
  const groupOf = (sp) => (sp.pkg.length > common.length && common.every((s, i) => sp.pkg[i] === s) ? sp.pkg[common.length] : null);
  const groups = new Map();
  const place = (list, key) => {
    for (const { f, sp } of list) {
      const g = groupOf(sp);
      if (g === null) continue;
      if (!groups.has(g)) groups.set(g, newUnit(g, 'package'));
      const u = groups.get(g);
      if (key === 'src') {
        u.src.add(f);
        u.prefixes.add([...common, g].join('.'));
        u.paths.add(f.split('/').slice(0, f.split('/').length - (sp.pkg.length - common.length - 1) - 1).join('/'));
      } else u.tests.add(f);
    }
  };
  place(mains, 'src');
  place(tests, 'tests');
  return [...groups.values()].filter((u) => u.src.size >= MIN_PACKAGE_FILES);
}

function importMatches(imp, prefix) {
  return imp === prefix || imp.startsWith(prefix + '.');
}

function computeFan(units, unitOfModule, modules, analyze) {
  const out = new Map(units.map((u) => [u, new Set()]));
  if (units[0]?.kind === 'module') {
    for (const m of modules) {
      const from = unitOfModule.get(m.path);
      if (!from) continue;
      for (const dep of m.projectDeps) {
        const to = unitOfModule.get(dep);
        if (to && to !== from) out.get(from).add(to);
      }
    }
  } else {
    for (const from of units) {
      for (const f of from.src) {
        for (const imp of analyze(f).imports) {
          for (const to of units) {
            if (to === from) continue;
            if ([...to.prefixes].some((p) => importMatches(imp, p))) out.get(from).add(to);
          }
        }
      }
    }
  }
  const fanIn = new Map(units.map((u) => [u, 0]));
  for (const tos of out.values()) for (const t of tos) fanIn.set(t, fanIn.get(t) + 1);
  return (u) => ({ fanOut: out.get(u).size, fanIn: fanIn.get(u) });
}

const words = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Risk keywords (case-insensitive, whole words; a plural `s` is accepted) matching a feature name. */
function matchRisk(name, keywords) {
  const w = words(name);
  return keywords.filter((k) => {
    const kw = words(k);
    if (kw.length === 0) return false;
    for (let i = 0; i + kw.length <= w.length; i++) {
      if (kw.every((x, j) => w[i + j] === x || (j === kw.length - 1 && w[i + j] === x + 's'))) return true;
    }
    return false;
  });
}

function sizeScore(loc, b) {
  if (loc <= b.smallLoc) return { value: 1, band: 0 };
  if (loc <= b.mediumLoc) return { value: 0.9, band: 1 };
  if (loc <= b.largeLoc) return { value: 0.4, band: 2 };
  return { value: 0.1, band: 2, huge: true };
}

/**
 * Rank migration candidates. Returns { features, fallback, churnAvailable }.
 * `churn` is churnByCommit output ([{ files }]) or null when git history is unavailable.
 */
export function buildFeatureMap(root, { profile, scoring, churn = null }) {
  const files = listFiles(root, { gitignore: true });
  const analyze = makeAnalyzer(root);
  const modules = profile.modules;

  let units = [];
  let unitOfModule = new Map();
  let fallback = 'none';
  const mu = moduleUnits(modules, files);
  if (mu.units.length > 0) {
    ({ units, unitOfModule } = mu);
  } else {
    units = packageFeatureUnits(files);
    if (units.length === 0) {
      units = fallbackPackageUnits(files);
      fallback = 'packages';
    }
    if (units.length === 0) {
      const u = newUnit('app', 'module');
      u.paths.add('.');
      for (const f of files) {
        if (isSource(f)) (isTestName(f) || (srcPath(f) && isTestSet(srcPath(f).set)) ? u.tests : u.src).add(f);
        else if (layoutPath(f) && !isTestSet(layoutPath(f).set)) u.layouts.add(f);
      }
      units = [u];
      fallback = 'app';
    }
  }
  units.sort((a, b) => byText(a.name, b.name));

  const fan = computeFan(units, unitOfModule, modules, analyze);
  const churnAvailable = Array.isArray(churn);
  const commitsOf = new Map(units.map((u) => [u, new Set()]));
  if (churnAvailable) {
    const owner = new Map();
    units.forEach((u, i) => {
      for (const f of [...u.src, ...u.layouts]) {
        if (!owner.has(f)) owner.set(f, []);
        owner.get(f).push(i);
      }
    });
    churn.forEach((c, n) => {
      if (!Array.isArray(c?.files) || c.files.length > BULK_COMMIT_FILES) return;
      for (const f of c.files) for (const i of owner.get(f) ?? []) commitsOf.get(units[i]).add(n);
    });
  }
  const rows = units.map((u, index) => {
    const srcFiles = [...u.src].sort(byText);
    const loc = srcFiles.reduce((s, f) => s + analyze(f).loc, 0);
    const bigFiles = srcFiles.filter((f) => analyze(f).big).length;
    let modern = 0;
    let legacy = u.layouts.size;
    for (const f of srcFiles) {
      const a = analyze(f);
      if (a.modern) modern++;
      else if (a.legacy) legacy++;
    }
    const riskHigh = matchRisk(u.name, scoring.riskKeywords.high);
    const riskMedium = matchRisk(u.name, scoring.riskKeywords.medium);
    const name = sanitizeName(u.name, index);
    return {
      id: name,
      name,
      kind: u.kind,
      paths: [...u.paths].sort(byText),
      files: srcFiles.length,
      loc,
      testFiles: u.tests.size,
      ...fan(u),
      churn: churnAvailable ? commitsOf.get(u).size : null,
      bigFiles,
      risk: riskHigh.length ? 'high' : riskMedium.length ? 'medium' : 'low',
      riskMatched: riskHigh.length ? riskHigh : riskMedium,
      proximity: modern + legacy === 0 ? 0 : Math.round((modern / (modern + legacy)) * 100) / 100,
      uiFiles: modern + legacy,
    };
  });

  const maxChurn = churnAvailable ? Math.max(0, ...rows.map((r) => r.churn)) : 0;
  const w = { ...scoring.weights };
  if (!churnAvailable || maxChurn === 0) w.churn = 0; // no signal: drop the weight and renormalise
  const wSum = Object.values(w).reduce((s, v) => s + v, 0);
  const features = rows.map((r) => {
    const size = sizeScore(r.loc, scoring.sizeBands);
    const input = {
      isolation: 1 / (1 + r.fanIn + r.fanOut),
      size: size.value,
      tests: Math.min(1, r.testFiles / 2),
      churn: maxChurn > 0 ? r.churn / maxChurn : 0,
      risk: r.risk === 'high' ? 0 : r.risk === 'medium' ? 0.5 : 1,
      proximity: r.proximity,
    };
    const raw = wSum > 0 ? Object.keys(w).reduce((s, k) => s + w[k] * input[k], 0) / wSum : 0;
    const score = round1(raw * 100);
    let bucket = score >= scoring.buckets.first ? 'first' : score >= scoring.buckets.next ? 'next' : 'last';
    const reasons = [];
    const coupling = `fanIn ${r.fanIn}, fanOut ${r.fanOut}`;
    reasons.push(r.fanIn + r.fanOut <= 1 ? `isolated: ${coupling}` : `coupled: ${coupling}`);
    reasons.push(`${BAND_LABEL[size.band]} size: ${r.loc} loc${size.huge ? ', consider splitting before migrating' : ''}`);
    reasons.push(r.testFiles === 0 ? 'no tests: write characterization tests first' : `${r.testFiles} test file${r.testFiles === 1 ? '' : 's'}`);
    if (churnAvailable) reasons.push(`churn: ${r.churn} commits in the last 6 months`);
    if (r.bigFiles > 0) reasons.push(`${r.bigFiles} files too large to scan (LOC estimated)`);
    if (r.risk !== 'low') reasons.push(`${r.risk} risk: matches ${r.riskMatched.join(', ')}`);
    reasons.push(r.uiFiles === 0 ? 'proximity 0: no UI source detected' : `proximity ${Math.round(r.proximity * 100)}%: ${r.uiFiles} UI files counted`);
    if (r.risk === 'high' && bucket === 'first') {
      bucket = 'next';
      reasons.push('capped to next: high-risk features are not pilot candidates');
    }
    if (size.huge && bucket === 'first') {
      bucket = 'next';
      reasons.push('large feature: not a pilot');
    }
    const { uiFiles, bigFiles, ...rest } = r; // eslint-disable-line no-unused-vars
    return { ...rest, score, bucket, reasons };
  });
  features.sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || b.score - a.score || byText(a.name, b.name));
  return { features, fallback, churnAvailable };
}
