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
import { headCommit, gitDir, addToExclude } from './git.js';
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

/**
 * Write the .ai folder. See task 4 for the ownership table.
 * Returns { written, kept, conflicts, pointers, excluded } with paths relative to root, sorted.
 */
export function writeAiDir(
  root,
  { now, local = false, appendPointers = false, workspace = null, toolVersion, skillDir = DEFAULT_SKILL_DIR, catalogDir } = {},
) {
  const realRoot = fs.realpathSync(root);
  const aiDir = path.join(root, '.ai');
  const templatesDir = path.join(skillDir, 'templates', 'ai');
  catalogDir = catalogDir ?? path.join(skillDir, 'catalog');
  toolVersion = toolVersion ?? resolveToolVersion(skillDir, aiDir);
  if (local && !gitDir(root)) throw new Error('--local needs a git repository');

  const written = new Set();
  const kept = new Set();
  const conflicts = [];
  const refuse = (rel) => new Error(`refusing to write through a symlink: ${rel}`);

  // Every component from root down to rel must not be a symlink, and the target must stay in root.
  const guard = (rel) => {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(realRoot + path.sep) && !abs.startsWith(path.resolve(root) + path.sep)) {
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

  // Preflight: nothing is written when .ai (or anything in it) or a pointer file is a symlink.
  guard('.ai');
  if (fs.existsSync(aiDir)) regularFiles(aiDir);
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md']) guard(f);

  const catalog = loadCatalog(catalogDir);
  const commit = headCommit(root);
  const files = listFiles(root);
  const profile = detectStack(root, catalog);
  const modules = discoverModules(root, files);
  const date = now.toISOString().slice(0, 10);
  const mode = local ? 'local' : 'committed';
  const meta = { date, commit, catalogVersion: catalog.catalogVersion };
  const previous = readManifest(aiDir);

  // generated
  putAi(
    'README.md',
    renderReadme(
      { toolVersion, catalogVersion: catalog.catalogVersion, date, commit, mode, workspace: workspace?.length ? workspace.join(', ') : 'none' },
      templatesDir,
    ),
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
  putAi('index/index.json', JSON.stringify(buildIndex(root, { now, commit, catalogVersion: catalog.catalogVersion })) + '\n');

  // tools: tool-owned, wiped and rewritten from the running skill
  const toolsAbs = guard('.ai/tools');
  fs.rmSync(toolsAbs, { recursive: true, force: true });
  const vendor = (srcDir, destRel) => {
    for (const rel of regularFiles(srcDir)) putAi(`${destRel}/${rel}`, fs.readFileSync(path.join(srcDir, rel)));
  };
  vendor(path.join(skillDir, 'scripts'), 'tools/scripts');
  vendor(catalogDir, 'tools/catalog');
  putAi('tools/package.json', '{"type":"module","private":true}\n');

  // managed workflows
  const managed = {};
  for (const name of WORKFLOWS) {
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

  // user-owned: create only when missing
  for (const rel of USER_TEMPLATES) {
    if (fs.existsSync(path.join(aiDir, rel))) kept.add(`.ai/${rel}`);
    else putAi(rel, readTemplate(rel, templatesDir));
  }
  for (const rel of USER_OPTIONAL) if (fs.existsSync(path.join(aiDir, rel))) kept.add(`.ai/${rel}`);
  const adrDir = path.join(aiDir, 'knowledge', 'adr');
  if (fs.existsSync(adrDir)) for (const f of regularFiles(adrDir)) kept.add(`.ai/knowledge/adr/${f}`);

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

  // pointers and local exclusion
  const pointers = applyPointers(root, {
    local,
    appendPointers,
    block: readTemplate('pointer.md', templatesDir),
    write: (rel, content) => put(rel, content),
  });
  const excluded = local ? ['.ai/', 'CLAUDE.local.md'] : [];
  if (local) addToExclude(root, excluded);

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
  if (headCommit(root) !== (manifest.commit ?? null)) stale.push('commit-moved');
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
