import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadCatalogWithOverrides } from './overrides.js';
import { detectStack } from './detect.js';
import { candidatePaths } from './candidates.js';
import { discoverModules } from './modules.js';
import { listFiles } from './walk.js';
import { buildIndex } from './indexer.js';
import { headCommit, gitDir, topLevel, addToExclude, changedSince, churnByCommit } from './git.js';
import { loadScoring } from './catalog.js';
import { buildFeatureMap } from './features.js';
import { sha256File, hashTree, regularFiles } from './hash.js';
import { MANIFEST_SCHEMA_VERSION, readManifest, writeManifest } from './manifest.js';
import { readTemplate, renderReadme, renderKnowledge, renderComponentsBlock, applyComponentsBlock } from './knowledge.js';
import { detectReuse } from './reuse.js';
import { applyPointers } from './pointers.js';
import { redact, redactJson } from './redact.js';
import { scanAiDir } from './injection.js';
import { collectVendorSources, verifyTools, selfCheckTools } from './integrity.js';

const DEFAULT_SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = ['01-read-context.md', '02-plan.md', '03-implement.md', '04-review.md'];
const USER_TEMPLATES = [
  'knowledge/architecture-target.md',
  'knowledge/conventions.md',
  'knowledge/adr/0000-template.md',
  'migration/roadmap.md',
  'catalog-overrides/README.md',
];
// Region-managed: user text everywhere except the block between the markers, which every run regenerates.
const COMPONENTS = 'knowledge/components.md';
const USER_OPTIONAL = ['recommendations.json', 'repos.json'];
// Paths whose changes do not make .ai stale: .ai itself and the pointer files init writes.
const OWN_PATHS = ['.ai', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md'];
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Version of the running tool: package.json, then .installed.json, then the existing manifest. */
export function resolveToolVersion(skillDir = DEFAULT_SKILL_DIR, aiDir = null) {
  const pkg = readJson(path.join(skillDir, '..', 'package.json'));
  if (pkg?.name === 'android-architect' && typeof pkg.version === 'string') return pkg.version;
  const installed = readJson(path.join(skillDir, '.installed.json'));
  if (typeof installed?.version === 'string') return installed.version;
  const manifest = aiDir ? readJson(path.join(aiDir, 'manifest.json')) : null;
  if (typeof manifest?.toolVersion === 'string') return manifest.toolVersion;
  return '0.0.0-unknown';
}

function workspaceLabel(workspace, repos) {
  if (!workspace) return 'none';
  if (workspace.role === 'member') return `member of ${workspace.hub}`;
  const n = (repos?.repos ?? []).filter((r) => r.path !== '.').length;
  return `hub (${n} ${n === 1 ? 'repo' : 'repos'})`;
}

/** Members have no workflows of their own: point the given text at the hub's. */
function hubWorkflows(text, hub) {
  return text
    .replace('Follow `.ai/workflows/`', `Follow the hub's workflows in \`${hub}/.ai/workflows/\``)
    .replace('Workflows live in `.ai/workflows/`', `Workflows live in the hub: \`${hub}/.ai/workflows/\``)
    .replace('CODEOWNERS entry for `.ai/workflows/` and', `CODEOWNERS entry for \`${hub}/.ai/workflows/\` (in the hub repo) and`);
}

function memberNote(hub) {
  return `\n## Workspace member\n\nThis repo is a member of a workspace. The target architecture, ADRs, conventions and roadmap live in the hub repo at \`${hub}\` (see \`${hub}/.ai/README.md\`). This folder holds only generated knowledge for this repo.\n`;
}

/**
 * The generatedAt to write: the previous one when rendering with it reproduces the existing file byte for byte (so a
 * re-run that changes nothing else leaves the file, and git, alone), else `nowIso`. render(generatedAt) returns the text.
 */
function stableStamp(file, nowIso, render) {
  try {
    const old = fs.readFileSync(file, 'utf8');
    const prev = JSON.parse(old)?.generatedAt;
    if (typeof prev === 'string' && render(prev) === old) return prev;
  } catch {
    // No readable previous file: use the new stamp.
  }
  return nowIso;
}

const refuse = (rel) => new Error(`refusing to write through a symlink: ${rel}`);

/** True when the project changed between the recorded commit and HEAD (ignoring .ai and pointer files). */
function commitMoved(root, recorded, head) {
  if (head === recorded) return false;
  if (head === null || recorded === null) return true;
  return changedSince(root, recorded, OWN_PATHS);
}

/** Returns guard(rel): throws when rel escapes root or passes through a symlink; else the absolute path. */
function makeGuard(root, realRoot) {
  // Every component from root down to rel must not be a symlink, and the target must stay in root.
  return (rel) => {
    const abs = path.resolve(root, rel);
    if (!path.resolve(realRoot, rel).startsWith(realRoot + path.sep)) {
      throw new Error(`refusing to write outside the project: ${rel}`);
    }
    let cur = root;
    for (const part of rel.split('/')) {
      cur = path.join(cur, part);
      let st = null;
      try {
        st = fs.lstatSync(cur);
      } catch {
        break;
      }
      if (st.isSymbolicLink()) throw refuse(path.relative(root, cur).split(path.sep).join('/'));
    }
    return abs;
  };
}

/**
 * Checks run before any write: --local needs a repo; .ai (and anything in it) and the pointer files must not be symlinks;
 * the catalog overrides (when present: .ai/catalog-overrides, or the hub's for a workspace member; `workspace` as in
 * overrideSource, undefined = from the manifest) must be valid against the catalog in `catalogDir` (default: this skill's); the
 * git-ignore check must work (it fails closed, so a git error throws here, before anything is written).
 * writeAiDir runs this itself; workspace mode runs it for every repo first.
 * Returns { catalog, base, files, listed }: the merged catalog (base + overrides), the base catalog, the override file
 * names and the project files (git-ignored ones dropped).
 */
export function preflight(root, { local = false, catalogDir = path.join(DEFAULT_SKILL_DIR, 'catalog'), workspace } = {}) {
  const realRoot = fs.realpathSync(root);
  const aiDir = path.join(root, '.ai');
  if (local && !gitDir(root)) throw new Error('--local needs a git repository');
  const guard = makeGuard(root, realRoot);
  guard('.ai');
  if (fs.existsSync(aiDir)) regularFiles(aiDir);
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md']) guard(f);
  const loaded = loadCatalogWithOverrides(catalogDir, root, { workspace });
  return { ...loaded, listed: listFiles(root, { gitignore: true }) };
}

const SAFE_GENERATED_REL = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

/**
 * Write generated files into an existing .ai folder with the same guard as writeAiDir: .ai and every component on the
 * way to each file must not be a symlink (nothing in .ai may be one), paths stay inside the project, and every text
 * passes through redact(). `files` is { relativePathUnderAi: text }. All paths are checked before the first write.
 * Throws when .ai does not exist (run init first). Returns the written paths relative to root (".ai/..."), sorted.
 */
export function writeGenerated(root, files) {
  const realRoot = fs.realpathSync(root);
  const guard = makeGuard(root, realRoot);
  const aiDir = path.join(root, '.ai');
  guard('.ai');
  let st = null;
  try {
    st = fs.lstatSync(aiDir);
  } catch {
    st = null;
  }
  if (st === null || !st.isDirectory()) throw new Error('no .ai folder; run init first');
  regularFiles(aiDir);
  const entries = Object.entries(files);
  for (const [rel] of entries) {
    if (!SAFE_GENERATED_REL.test(rel) || rel.split('/').some((seg) => seg === '.' || seg === '..')) {
      throw new Error('refusing to write a generated file with an unsafe path');
    }
    guard(`.ai/${rel}`);
  }
  const written = [];
  for (const [rel, text] of entries) {
    const abs = guard(`.ai/${rel}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    guard(`.ai/${rel}`);
    fs.writeFileSync(abs, redact(String(text)).text);
    written.push(`.ai/${rel}`);
  }
  return written.sort(byText);
}

/**
 * Write the .ai folder. See task 4 for the ownership table.
 * `workspace` is null, { role: 'hub', hub: '.' } (with `repos`, the repos.json content: written when missing or when the
 * existing one is only a proposal, else written as repos.json.new on a difference)
 * or { role: 'member', hub: <relative path> } (thin .ai: no workflows, no user-owned files).
 * `extraGenerated` is { name: text } or a function of { written, kept, conflicts, commit } returning that: extra generated
 * files written at the top of .ai (always rewritten, through the same guarded writer).
 * `prepared` is { loaded, profile } from a caller that already ran preflight (same options) and detectStack on its
 * catalog (refresh), so neither runs twice; the profile is recomputed when the pointers create a file.
 * Returns { written, kept, conflicts, notes, pointers, excluded, suspicious } with paths relative to root, sorted (suspicious:
 * scanAiDir findings once everything is written).
 */
export function writeAiDir(
  root,
  { now, local = false, appendPointers = false, workspace = null, repos = null, toolVersion, skillDir = DEFAULT_SKILL_DIR, catalogDir, extraGenerated = null, prepared = null } = {},
) {
  const realRoot = fs.realpathSync(root);
  const aiDir = path.join(root, '.ai');
  const templatesDir = path.join(skillDir, 'templates', 'ai');
  catalogDir = catalogDir ?? path.join(skillDir, 'catalog');

  const isMember = workspace?.role === 'member';
  const written = new Set();
  const kept = new Set();
  const conflicts = [];

  const guard = makeGuard(root, realRoot);
  const put = (rel, content) => {
    const abs = guard(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  const putAi = (rel, content) => {
    put(`.ai/${rel}`, content);
    written.add(`.ai/${rel}`);
  };

  // Generated texts (knowledge, README, candidates, refresh report) go through redact(); vendored tool sources and the
  // manifest (hashes) are written as they are.
  const putRedacted = (rel, text) => putAi(rel, redact(text).text);

  // Overrides are validated here, before the first write; the result is reused for detection below.
  const loaded = prepared?.loaded ?? preflight(root, { local, catalogDir, workspace });

  // Vendor sources are read into memory before the first write, and must not live inside .ai.
  const vendorSources = collectVendorSources(skillDir, catalogDir, { aiDir });
  toolVersion = toolVersion ?? resolveToolVersion(skillDir, aiDir);

  // Detection and candidates use base + project overrides; vendoring (above) copies the base catalog only.
  const { catalog, base, files: overrideFiles } = loaded;
  const previous = readManifest(aiDir);
  const head = headCommit(root);
  // Keep the recorded commit when only .ai or pointer files changed since, so committing .ai does not churn headers.
  const recorded = previous?.commit ?? null;
  const commit = recorded !== null && head !== null && !commitMoved(root, recorded, head) ? recorded : head;

  // Pointers first, so the file counts and index below already include them and a re-run does not change them.
  const pointers = applyPointers(root, {
    local,
    appendPointers,
    block: isMember ? hubWorkflows(readTemplate('pointer.md', templatesDir), workspace.hub) : readTemplate('pointer.md', templatesDir),
    write: (rel, content) => put(rel, content),
  });
  // The preflight listing, unless the pointers just created a file it could not include.
  const pointersCreated = pointers.some((p) => p.action === 'created');
  const files = pointersCreated ? listFiles(root, { gitignore: true }) : loaded.listed;
  const profile = !pointersCreated && prepared?.profile ? prepared.profile : detectStack(root, catalog);
  const modules = discoverModules(root, files);
  // One feature-map computation per run, shared by the knowledge files.
  const scoringDir = fs.existsSync(path.join(catalogDir, 'scoring.json')) ? catalogDir : undefined;
  // Advisory: a broken scoring.json or a failure here must not abort the run.
  let featureMap;
  try {
    featureMap = buildFeatureMap(root, { profile, scoring: loadScoring(scoringDir), churn: churnByCommit(root) });
  } catch (e) {
    featureMap = { error: String(e?.message ?? e) };
  }
  // Advisory like the feature map: a failure becomes a line in components.md, never an aborted run.
  let reuse = null;
  if (!isMember) {
    try {
      reuse = detectReuse(root, { profile, files, modules });
    } catch (e) {
      reuse = { error: String(e?.message ?? e) };
    }
  }
  const date = now.toISOString().slice(0, 10);
  const mode = local ? 'local' : 'committed';
  const meta = { date, commit, catalogVersion: catalog.catalogVersion };

  // generated
  const readme = renderReadme(
    { toolVersion, catalogVersion: catalog.catalogVersion, date, commit, mode, workspace: workspaceLabel(workspace, repos) },
    templatesDir,
  );
  putRedacted('README.md', isMember ? hubWorkflows(readme, workspace.hub) + memberNote(workspace.hub) : readme);
  for (const [rel, text] of Object.entries(renderKnowledge(profile, modules, catalog, meta, featureMap))) putRedacted(rel, text);
  const candidates = candidatePaths(profile, catalog);
  const renderCandidates = (generatedAt) =>
    JSON.stringify(redactJson({ catalogVersion: catalog.catalogVersion, generatedAt, candidates }), null, 2) + '\n';
  putAi('candidates.json', renderCandidates(stableStamp(path.join(aiDir, 'candidates.json'), now.toISOString(), renderCandidates)));

  // tools: tool-owned, wiped and rewritten from the running skill
  const toolsAbs = guard('.ai/tools');
  fs.rmSync(toolsAbs, { recursive: true, force: true });
  for (const [rel, data] of vendorSources) putAi(`tools/${rel}`, data);

  // managed workflows (hub and standalone only)
  const managed = {};
  for (const name of isMember ? [] : WORKFLOWS) {
    const rel = `workflows/${name}`;
    const next = readTemplate(rel, templatesDir);
    const abs = path.join(aiDir, rel);
    const prevHash = previous?.managed?.[rel];
    const current = fs.existsSync(abs) ? sha256File(abs) : null;
    if (current === null || current === prevHash || current === sha(next)) {
      putAi(rel, next);
      managed[rel] = sha(next);
      fs.rmSync(guard(`.ai/${rel}.new`), { force: true });
    } else {
      putAi(`${rel}.new`, next);
      conflicts.push(`.ai/${rel}`);
      if (prevHash) managed[rel] = prevHash;
    }
  }

  // repos.json: created when missing; a tool-proposed one (every repo confirmed:false) is replaced; an identical one is
  // left alone; any other difference goes to repos.json.new as a conflict.
  const writeRepos = (next) => {
    const rel = 'repos.json';
    const text = JSON.stringify(next, null, 2) + '\n';
    const current = readJson(path.join(aiDir, rel));
    const exists = fs.existsSync(path.join(aiDir, rel));
    const proposedOnly = Array.isArray(current?.repos) && current.repos.length > 0 && current.repos.every((r) => r?.confirmed === false);
    if (exists && JSON.stringify(current) === JSON.stringify(next)) {
      fs.rmSync(guard(`.ai/${rel}.new`), { force: true });
    } else if (!exists || proposedOnly) {
      putAi(rel, text);
      fs.rmSync(guard(`.ai/${rel}.new`), { force: true });
    } else {
      putAi(`${rel}.new`, text);
      conflicts.push(`.ai/${rel}`);
    }
  };

  // user-owned: create only when missing (never in a member repo)
  for (const rel of isMember ? [] : USER_TEMPLATES) {
    if (fs.existsSync(path.join(aiDir, rel))) kept.add(`.ai/${rel}`);
    else putAi(rel, readTemplate(rel, templatesDir));
  }
  if (!isMember) {
    if (workspace?.role === 'hub' && repos) writeRepos(repos);
    for (const rel of USER_OPTIONAL) {
      if (!written.has(`.ai/${rel}`) && fs.existsSync(path.join(aiDir, rel))) kept.add(`.ai/${rel}`);
    }
  }
  // components.md: created from the template when missing; otherwise only the marked block is rewritten (redacted like
  // every generated text; the user's own text is never redacted or changed).
  const notes = [];
  if (!isMember) {
    const abs = path.join(aiDir, COMPONENTS);
    const exists = fs.existsSync(abs);
    const raw = exists ? fs.readFileSync(abs) : null;
    const existing = exists ? raw.toString('utf8') : readTemplate(COMPONENTS, templatesDir);
    if (exists && !Buffer.from(existing, 'utf8').equals(raw)) {
      // Not valid UTF-8: rewriting would corrupt the user's bytes, so the file is left alone.
      notes.push('knowledge/components.md is not valid UTF-8: left untouched, the generated block was not updated');
      kept.add(`.ai/${COMPONENTS}`);
    } else {
      const { text, note } = applyComponentsBlock(existing, redact(renderComponentsBlock(reuse)).text);
      if (note) notes.push(note);
      if (!exists || text !== existing) putAi(COMPONENTS, text);
      else kept.add(`.ai/${COMPONENTS}`);
    }
  }
  const adrDir = path.join(aiDir, 'knowledge', 'adr');
  if (!isMember && fs.existsSync(adrDir)) {
    for (const f of regularFiles(adrDir)) if (!written.has(`.ai/knowledge/adr/${f}`)) kept.add(`.ai/knowledge/adr/${f}`);
  }

  // The index covers .ai/knowledge, so it is built once the knowledge files above exist.
  const index = buildIndex(root, { now, commit, catalogVersion: catalog.catalogVersion });
  const renderIndex = (generatedAt) => JSON.stringify({ ...index, generatedAt }) + '\n';
  putAi('index/index.json', renderIndex(stableStamp(path.join(aiDir, 'index', 'index.json'), index.generatedAt, renderIndex)));

  const extra = typeof extraGenerated === 'function'
    ? extraGenerated({ written: [...written].sort(byText), kept: [...kept].sort(byText), conflicts: [...conflicts].sort(byText), commit, notes: [...notes] })
    : extraGenerated ?? {};
  for (const [rel, text] of Object.entries(extra)) putRedacted(rel, text);

  const manifestFor = (generatedAt) => ({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    toolVersion,
    // The base version, so ai-status compares like with like; the merged one ("+overrides") only labels generated files.
    catalogVersion: base.catalogVersion,
    overrides: overrideFiles,
    // Active pins and added entries, so refresh can report what changed between runs.
    overridePins: Object.fromEntries(Object.entries(catalog.overridden?.pins ?? {}).map(([k, v]) => [k, v.status])),
    overrideAdded: catalog.overridden?.added ?? [],
    generatedAt,
    commit,
    mode,
    workspace,
    managed,
    tools,
  });
  const tools = hashTree(toolsAbs);
  const renderManifest = (generatedAt) => JSON.stringify(manifestFor(generatedAt), null, 2) + '\n';
  writeManifest(aiDir, manifestFor(stableStamp(path.join(aiDir, 'manifest.json'), now.toISOString(), renderManifest)));
  written.add('.ai/manifest.json');

  // local exclusion
  let excluded = [];
  if (local) {
    const sub = path.relative(fs.realpathSync(topLevel(root)), realRoot).split(path.sep).filter(Boolean).join('/');
    const prefix = sub ? `/${sub}/` : '/';
    excluded = [`${prefix}.ai/`, `${prefix}CLAUDE.local.md`];
    addToExclude(root, excluded);
  }

  return {
    written: [...written].sort(byText),
    kept: [...kept].sort(byText),
    conflicts: conflicts.sort(byText),
    notes,
    pointers,
    excluded,
    suspicious: scanAiDir(root),
  };
}

/**
 * Report how stale the .ai folder is. Stale is information, not failure.
 * The vendored tools are verified against the running skill (skillDir, catalogDir, toolVersion); with `selfCheck`
 * (a vendored copy running itself) only against manifest.json, which is weaker and reported as trusted: false.
 */
export function aiStatus(root, { toolCatalogVersion, skillDir = DEFAULT_SKILL_DIR, catalogDir, toolVersion, selfCheck = false }) {
  const aiDir = path.join(root, '.ai');
  const manifest = readManifest(aiDir);
  if (!manifest) return { ok: false, stale: ['no-manifest'], manifest: null, suspicious: [] };
  const stale = [];
  if (commitMoved(root, manifest.commit ?? null, headCommit(root))) stale.push('commit-moved');
  if (toolCatalogVersion !== manifest.catalogVersion) stale.push('catalog-moved');
  const tools = selfCheck
    ? selfCheckTools(aiDir)
    : verifyTools(root, { skillDir, catalogDir, toolVersion: toolVersion ?? resolveToolVersion(skillDir, aiDir) });
  if (tools.status === 'modified') stale.push('tools-modified');
  if (tools.status === 'unverifiable') stale.push('tools-unverifiable');
  return { ok: stale.length === 0, stale, manifest, tools: { ...tools, trusted: !selfCheck }, suspicious: scanAiDir(root) };
}
