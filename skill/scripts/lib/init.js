import fs from 'node:fs';
import path from 'node:path';
import { writeAiDir, preflight } from './aidir.js';
import { siblingRepos, linkWorkspace } from './workspace.js';
import { readManifest } from './manifest.js';
import { hubListsRepo } from './overrides.js';

export const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** True when dir exists and has a Gradle build or settings file. */
export function isGradleProject(dir) {
  try {
    return fs.statSync(dir).isDirectory() && BUILD_FILES.some((f) => fs.existsSync(path.join(dir, f)));
  } catch {
    return false;
  }
}

const inside = (parent, p) => p === parent || p.startsWith(parent + path.sep);
const SWITCH_HINT = 'switching is not supported: remove .ai/ and run init again';

/** The mode and role an existing .ai was set up with, or null when there is no manifest. */
function existingSetup(dir) {
  const m = readManifest(path.join(dir, '.ai'));
  if (m === null) return null;
  const role = m.workspace?.role === 'member' || m.workspace?.role === 'hub' ? m.workspace.role : 'standalone';
  const label = role === 'member' ? `member of ${m.workspace.hub}` : role;
  return { mode: m.mode === 'local' ? 'local' : 'committed', role, label, workspace: m.workspace ?? null };
}

const refuseSwitch = (where, setup, what) =>
  new Error(`${where} is set up in ${setup.mode} mode as ${setup.label}; ${what} would switch it, and ${SWITCH_HINT}`);

/** Validate every workspace repo before anything is written. Relative paths resolve against the hub. */
function planWorkspace(root, { local, workspace, catalogDir }) {
  const hub = fs.realpathSync(root);
  preflight(root, { local, catalogDir, workspace: { role: 'hub', hub: '.' } });
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
    const hubRel = path.relative(abs, hub).split(path.sep).join('/');
    if (confirmed) {
      preflight(abs, { local, catalogDir, workspace: { role: 'member', hub: hubRel }, trustedHub: true });
      const setup = existingSetup(abs);
      if (setup && (setup.role !== 'member' || setup.mode !== (local ? 'local' : 'committed'))) {
        throw refuseSwitch(p, setup, `making it a ${local ? 'local' : 'committed'} workspace member`);
      }
      if (setup) {
        const oldHub = path.resolve(abs, setup.workspace.hub);
        let oldReal = oldHub;
        try {
          oldReal = fs.realpathSync(oldHub);
        } catch {
          // The old hub is gone: it still differs from this one.
        }
        if (oldReal !== hub) {
          throw new Error(`${p} is already a member of the workspace hub at ${setup.workspace.hub}; to move it, remove its .ai/ and run init again from the new hub`);
        }
      }
    }
    members.push({
      abs,
      name: path.basename(abs),
      hubRel,
    });
  }
  return { members, repos: linkWorkspace(hub, members.map((m) => m.abs), { confirmed }) };
}

/**
 * Initialize .ai for one repo, or for a workspace hub and its members when `workspace` is an array of paths
 * (empty = propose sibling repos: only the hub is written, with `confirmed: false`, and `proposed` lists them). Returns the writeAiDir result, or { hub, members, repos } in workspace mode.
 * On a re-run the existing manifest's mode and workspace role are kept; a flag that would switch them throws.
 * `skillDir`, `catalogDir` and `toolVersion` pass through to writeAiDir.
 */
export function initProject(root, { now = new Date(), local = false, appendPointers = false, workspace = null, skillDir, catalogDir, toolVersion } = {}) {
  // A re-run keeps the mode and workspace role from the existing manifest; flags that would change them are refused.
  const setup = existingSetup(root);
  if (setup) {
    if (local && setup.mode === 'committed') throw refuseSwitch('this project', setup, '--local');
    if (workspace !== null && setup.role !== 'hub') {
      throw refuseSwitch('this project', setup, '--workspace');
    }
    local = setup.mode === 'local';
  }
  const base = { now, local, appendPointers, skillDir, catalogDir, toolVersion };
  if (workspace === null && setup?.role === 'member') return writeAiDir(root, { ...base, workspace: setup.workspace });
  if (workspace === null && setup?.role === 'hub') {
    return writeAiDir(root, { ...base, workspace: { role: 'hub', hub: '.' }, repos: readJson(path.join(root, '.ai', 'repos.json')) });
  }
  if (workspace === null) return writeAiDir(root, base);
  const plan = planWorkspace(root, { local, workspace, catalogDir });
  const members = {};
  if (workspace.length === 0) {
    // Detected siblings are only proposed: write the hub, leave the siblings untouched until the user confirms paths.
    const hubReal = fs.realpathSync(root);
    let proposed = plan.members.map((m) => path.relative(hubReal, m.abs).split(path.sep).join('/'));
    let repos = plan.repos;
    // A confirmed repos.json that already lists every sibling has nothing left to propose: keep it as it is.
    const existing = readJson(path.join(root, '.ai', 'repos.json'));
    if (
      Array.isArray(existing?.repos) &&
      !existing.repos.every((r) => r?.confirmed === false) &&
      proposed.every((p) => existing.repos.some((r) => r?.path === p))
    ) {
      repos = existing;
      proposed = [];
    }
    const hub = writeAiDir(root, { ...base, workspace: { role: 'hub', hub: '.' }, repos });
    return { hub, members, repos, proposed };
  }
  const hub = writeAiDir(root, { ...base, workspace: { role: 'hub', hub: '.' }, repos: plan.repos });
  for (const m of plan.members) {
    // The hub is written now: verify it normally when its repos.json lists this member. When an existing, different
    // repos.json was kept (the new one went to repos.json.new), the member is not listed yet, so the hub path given on the
    // command line is trusted for this run only; later runs verify.
    const listed = hubListsRepo(fs.realpathSync(root), readJson(path.join(root, '.ai', 'repos.json')), m.abs);
    members[m.name] = writeAiDir(m.abs, { ...base, workspace: { role: 'member', hub: m.hubRel }, trustedHub: !listed });
  }
  return { hub, members, repos: plan.repos };
}
