import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './catalog.js';
import { detectStack } from './detect.js';
import { candidatePaths } from './candidates.js';
import { discoverModules } from './modules.js';
import { listFiles } from './walk.js';
import { buildIndex } from './indexer.js';
import { headCommit, gitDir, topLevel, addToExclude, changedSince } from './git.js';
import { sha256File, hashTree } from './hash.js';
import { MANIFEST_SCHEMA_VERSION, readManifest, writeManifest } from './manifest.js';
import { readTemplate, renderReadme, renderKnowledge } from './knowledge.js';
import { applyPointers } from './pointers.js';

const DEFAULT_SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = ['01-read-context.md', '02-plan.md', '03-implement.md', '04-review.md'];
const USER_TEMPLATES = [
  'knowledge/architecture-target.md',
  'knowledge/conventions.md',
  'knowledge/components.md',
  'knowledge/adr/0000-template.md',
  'migration/roadmap.md',
];
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

function memberNote(hub) {
  return `\n## Workspace member\n\nThis repo is a member of a workspace. The target architecture, ADRs, conventions and roadmap live in the hub repo at \`${hub}\` (see \`${hub}/.ai/README.md\`). This folder holds only generated knowledge for this repo.\n`;
}

/** Every file under dir (regular files only); throws on symlinks. Paths relative to dir, sorted. */
function regularFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${r}`);
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort(byText);
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
 * Checks run before any write: --local needs a repo; .ai (and anything in it) and the pointer files must not be symlinks.
 * writeAiDir runs this itself; workspace mode runs it for every repo first.
 */
export function preflight(root, { local = false } = {}) {
  const realRoot = fs.realpathSync(root);
  const aiDir = path.join(root, '.ai');
  if (local && !gitDir(root)) throw new Error('--local needs a git repository');
  const guard = makeGuard(root, realRoot);
  guard('.ai');
  if (fs.existsSync(aiDir)) regularFiles(aiDir);
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md']) guard(f);
}

/**
 * Write the .ai folder. See task 4 for the ownership table.
 * `workspace` is null, { role: 'hub', hub: '.' } (with `repos`, the repos.json content, written only when missing)
 * or { role: 'member', hub: <relative path> } (thin .ai: no workflows, no user-owned files).
 * `extraGenerated` is { name: text } or a function of { written, kept, conflicts, commit } returning that: extra generated
 * files written at the top of .ai (always rewritten, through the same guarded writer).
 * Returns { written, kept, conflicts, pointers, excluded } with paths relative to root, sorted.
 */
export function writeAiDir(
  root,
  { now, local = false, appendPointers = false, workspace = null, repos = null, toolVersion, skillDir = DEFAULT_SKILL_DIR, catalogDir, extraGenerated = null } = {},
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

  preflight(root, { local });

  // Vendor sources are read into memory before the first write, and must not live inside .ai.
  const realAi = fs.existsSync(aiDir) ? fs.realpathSync(aiDir) : path.join(realRoot, '.ai');
  const vendorSources = [
    ['tools/scripts', path.join(skillDir, 'scripts')],
    ['tools/catalog', catalogDir],
  ].flatMap(([destRel, srcDir]) => {
    const realSrc = fs.realpathSync(srcDir);
    if (realSrc === realAi || realSrc.startsWith(realAi + path.sep)) {
      throw new Error(
        `refusing to vendor from inside .ai (${srcDir}): a vendored copy cannot regenerate .ai; run the installed skill or npx android-architect`,
      );
    }
    return regularFiles(srcDir).map((rel) => [`${destRel}/${rel}`, fs.readFileSync(path.join(srcDir, rel))]);
  });
  toolVersion = toolVersion ?? resolveToolVersion(skillDir, aiDir);

  const catalog = loadCatalog(catalogDir);
  const previous = readManifest(aiDir);
  const head = headCommit(root);
  // Keep the recorded commit when only .ai or pointer files changed since, so committing .ai does not churn headers.
  const recorded = previous?.commit ?? null;
  const commit = recorded !== null && head !== null && !commitMoved(root, recorded, head) ? recorded : head;

  // Pointers first, so the file counts and index below already include them and a re-run does not change them.
  const pointers = applyPointers(root, {
    local,
    appendPointers,
    block: readTemplate('pointer.md', templatesDir),
    write: (rel, content) => put(rel, content),
  });
  const files = listFiles(root);
  const profile = detectStack(root, catalog);
  const modules = discoverModules(root, files);
  const date = now.toISOString().slice(0, 10);
  const mode = local ? 'local' : 'committed';
  const meta = { date, commit, catalogVersion: catalog.catalogVersion };

  // generated
  putAi(
    'README.md',
    renderReadme(
      { toolVersion, catalogVersion: catalog.catalogVersion, date, commit, mode, workspace: workspaceLabel(workspace, repos) },
      templatesDir,
    ) + (isMember ? memberNote(workspace.hub) : ''),
  );
  for (const [rel, text] of Object.entries(renderKnowledge(profile, modules, catalog, meta))) putAi(rel, text);
  putAi(
    'candidates.json',
    JSON.stringify(
      { catalogVersion: catalog.catalogVersion, generatedAt: now.toISOString(), candidates: candidatePaths(profile, catalog) },
      null,
      2,
    ) + '\n',
  );

  // tools: tool-owned, wiped and rewritten from the running skill
  const toolsAbs = guard('.ai/tools');
  fs.rmSync(toolsAbs, { recursive: true, force: true });
  for (const [rel, data] of vendorSources) putAi(rel, data);
  putAi('tools/package.json', '{"type":"module","private":true}\n');

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

  // user-owned: create only when missing (never in a member repo)
  for (const rel of isMember ? [] : USER_TEMPLATES) {
    if (fs.existsSync(path.join(aiDir, rel))) kept.add(`.ai/${rel}`);
    else putAi(rel, readTemplate(rel, templatesDir));
  }
  if (!isMember) {
    if (workspace?.role === 'hub' && repos && !fs.existsSync(path.join(aiDir, 'repos.json'))) {
      putAi('repos.json', JSON.stringify(repos, null, 2) + '\n');
    }
    for (const rel of USER_OPTIONAL) if (fs.existsSync(path.join(aiDir, rel))) kept.add(`.ai/${rel}`);
  }
  const adrDir = path.join(aiDir, 'knowledge', 'adr');
  if (!isMember && fs.existsSync(adrDir)) for (const f of regularFiles(adrDir)) kept.add(`.ai/knowledge/adr/${f}`);

  // The index covers .ai/knowledge, so it is built once the knowledge files above exist.
  putAi('index/index.json', JSON.stringify(buildIndex(root, { now, commit, catalogVersion: catalog.catalogVersion })) + '\n');

  const extra = typeof extraGenerated === 'function'
    ? extraGenerated({ written: [...written].sort(byText), kept: [...kept].sort(byText), conflicts: [...conflicts].sort(byText), commit })
    : extraGenerated ?? {};
  for (const [rel, text] of Object.entries(extra)) putAi(rel, text);

  writeManifest(aiDir, {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    toolVersion,
    catalogVersion: catalog.catalogVersion,
    generatedAt: now.toISOString(),
    commit,
    mode,
    workspace,
    managed,
    tools: hashTree(toolsAbs),
  });
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
    pointers,
    excluded,
  };
}

/** Report how stale the .ai folder is. Stale is information, not failure. */
export function aiStatus(root, { toolCatalogVersion }) {
  const aiDir = path.join(root, '.ai');
  const manifest = readManifest(aiDir);
  if (!manifest) return { ok: false, stale: ['no-manifest'], manifest: null };
  const stale = [];
  if (commitMoved(root, manifest.commit ?? null, headCommit(root))) stale.push('commit-moved');
  if (toolCatalogVersion !== manifest.catalogVersion) stale.push('catalog-moved');
  let tools = {};
  try {
    if (fs.existsSync(path.join(aiDir, 'tools'))) tools = hashTree(path.join(aiDir, 'tools'));
  } catch {
    tools = null;
  }
  if (tools === null || JSON.stringify(tools) !== JSON.stringify(manifest.tools ?? {})) stale.push('tools-modified');
  return { ok: stale.length === 0, stale, manifest };
}
