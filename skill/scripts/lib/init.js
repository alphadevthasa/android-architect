import fs from 'node:fs';
import path from 'node:path';
import { writeAiDir, preflight } from './aidir.js';
import { siblingRepos, linkWorkspace } from './workspace.js';

export const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];

/** True when dir exists and has a Gradle build or settings file. */
export function isGradleProject(dir) {
  try {
    return fs.statSync(dir).isDirectory() && BUILD_FILES.some((f) => fs.existsSync(path.join(dir, f)));
  } catch {
    return false;
  }
}

const inside = (parent, p) => p === parent || p.startsWith(parent + path.sep);

/** Validate every workspace repo before anything is written. Relative paths resolve against the hub. */
function planWorkspace(root, { local, workspace }) {
  const hub = fs.realpathSync(root);
  preflight(root, { local });
  const confirmed = workspace.length > 0;
  const given = confirmed ? workspace : siblingRepos(hub);
  if (!given.length) throw new Error('no sibling Gradle repos found; pass repo paths to --workspace');
  const members = [];
  for (const p of given) {
    let abs;
    try {
      abs = fs.realpathSync(path.resolve(hub, p));
    } catch {
      throw new Error(`workspace path does not exist: ${p}`);
    }
    if (!fs.statSync(abs).isDirectory()) throw new Error(`workspace path is not a directory: ${p}`);
    if (!BUILD_FILES.some((f) => fs.existsSync(path.join(abs, f)))) throw new Error(`workspace path has no Gradle build files: ${p}`);
    if (inside(hub, abs) || inside(abs, hub)) throw new Error(`workspace path must be outside the hub and must not contain it: ${p}`);
    if (members.some((m) => m.abs === abs)) throw new Error(`workspace path listed twice: ${p}`);
    if (path.basename(abs) === path.basename(hub) || members.some((m) => m.name === path.basename(abs))) throw new Error(`workspace repos need distinct names: ${path.basename(abs)}`);
    if (confirmed) preflight(abs, { local });
    members.push({
      abs,
      name: path.basename(abs),
      hubRel: path.relative(abs, hub).split(path.sep).join('/'),
    });
  }
  return { members, repos: linkWorkspace(hub, members.map((m) => m.abs), { confirmed }) };
}

/**
 * Initialize .ai for one repo, or for a workspace hub and its members when `workspace` is an array of paths
 * (empty = propose sibling repos: only the hub is written, with `confirmed: false`, and `proposed` lists them). Returns the writeAiDir result, or { hub, members, repos } in workspace mode.
 * `skillDir`, `catalogDir` and `toolVersion` pass through to writeAiDir.
 */
export function initProject(root, { now = new Date(), local = false, appendPointers = false, workspace = null, skillDir, catalogDir, toolVersion } = {}) {
  const base = { now, local, appendPointers, skillDir, catalogDir, toolVersion };
  if (workspace === null) return writeAiDir(root, base);
  const plan = planWorkspace(root, { local, workspace });
  const hub = writeAiDir(root, { ...base, workspace: { role: 'hub', hub: '.' }, repos: plan.repos });
  const members = {};
  if (workspace.length === 0) {
    // Detected siblings are only proposed: write the hub, leave the siblings untouched until the user confirms paths.
    const hubReal = fs.realpathSync(root);
    const proposed = plan.members.map((m) => path.relative(hubReal, m.abs).split(path.sep).join('/'));
    return { hub, members, repos: plan.repos, proposed };
  }
  for (const m of plan.members) {
    members[m.name] = writeAiDir(m.abs, { ...base, workspace: { role: 'member', hub: m.hubRel } });
  }
  return { hub, members, repos: plan.repos };
}
