import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadCatalog } from './catalog.js';
import { aiStatus } from './aidir.js';

const NAME = 'android-architect';
const HARNESSES = [
  { name: 'claude', dir: '.claude' },
  { name: 'codex', dir: '.codex' },
];

export class NoHarnessError extends Error {
  constructor() {
    super('No Claude Code or Codex directory found. Pass --claude or --codex to choose where to install.');
    this.name = 'NoHarnessError';
  }
}

const readPackage = () =>
  JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

const targetOf = (home, h) => path.join(home, h.dir, 'skills', NAME);

// Resolve the real skills dir for a harness. Returns null when it is missing
// and create is false.
function resolveSkills(home, h, create) {
  const skills = path.join(home, h.dir, 'skills');
  if (create) fs.mkdirSync(skills, { recursive: true });
  else if (!fs.existsSync(skills)) return null;
  const skillsDir = fs.realpathSync(skills);
  const target = path.join(skillsDir, NAME);
  if (path.dirname(target) !== skillsDir || path.basename(target) !== NAME) {
    throw new Error(`Refusing unexpected target path: ${target}`);
  }
  return { skillsDir, target };
}

const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

// Throws if removing target would be unsafe or unwanted. Does not modify anything.
function checkRemovable(target, force) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  if (st.isSymbolicLink() || force) return;
  if (!st.isDirectory() || !fs.existsSync(path.join(target, '.installed.json'))) {
    throw new Error(`${target} does not look like an android-architect install (no .installed.json). Use --force to replace it.`);
  }
}

// Remove only the exact target. A symlink is unlinked, never followed.
function removeTarget(target, force) {
  checkRemovable(target, force);
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) fs.unlinkSync(target);
  else fs.rmSync(target, { recursive: true, force: true });
  return true;
}

export function install({ home, claude = false, codex = false, force = false, sourceDir, _copy }) {
  const src = sourceDir instanceof URL ? sourceDir.pathname : sourceDir;
  const copy = _copy ?? ((from, to) => fs.cpSync(from, to, { recursive: true, dereference: false }));
  const explicit = { claude, codex };
  let chosen = HARNESSES.filter((h) => explicit[h.name]);
  const isExplicit = chosen.length > 0;
  if (!isExplicit) {
    chosen = HARNESSES.filter((h) => fs.existsSync(path.join(home, h.dir)));
    if (chosen.length === 0) throw new NoHarnessError();
  }
  const version = readPackage().version;
  const catalogVersion = loadCatalog(path.join(src, 'catalog')).catalogVersion;
  const realSrc = fs.realpathSync(src);

  // Validate every target before touching anything.
  const plans = chosen.map((h) => {
    const { skillsDir, target } = resolveSkills(home, h, true);
    let realTarget = target;
    try {
      realTarget = fs.realpathSync(target);
    } catch {}
    if (overlaps(realSrc, target) || overlaps(realSrc, realTarget)) {
      throw new Error(`Refusing to install: source ${realSrc} and target ${target} overlap.`);
    }
    checkRemovable(target, force);
    return { h, skillsDir, target };
  });

  const installed = [];
  for (const { skillsDir, target } of plans) {
    const stage = path.join(skillsDir, `${NAME}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    try {
      copy(src, stage);
      fs.writeFileSync(
        path.join(stage, '.installed.json'),
        JSON.stringify({ version, catalogVersion, installedAt: new Date().toISOString() }, null, 2) + '\n',
      );
      removeTarget(target, force);
      fs.renameSync(stage, target);
      installed.push(target);
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      const done = installed.length ? ` Already installed: ${installed.join(', ')}.` : '';
      throw new Error(`Install to ${target} failed: ${e.message}.${done}`);
    }
  }
  return { installed };
}

function readInstalled(home, h) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(targetOf(home, h), '.installed.json'), 'utf8'));
    return { version: meta.version, catalogVersion: meta.catalogVersion };
  } catch {
    return null;
  }
}

/** Reinstall into every harness that already has a valid install (.installed.json). Never creates a new harness. */
export function update({ home, sourceDir }) {
  const present = HARNESSES.map((h) => ({ h, from: readInstalled(home, h) })).filter((x) => x.from);
  if (present.length === 0) throw new Error('nothing installed: run "npx android-architect install" first');
  const updated = [];
  for (const { h, from } of present) {
    install({ home, sourceDir, [h.name]: true });
    updated.push({ harness: h.name, from, to: readInstalled(home, h) });
  }
  return { updated };
}

export function uninstall({ home, force = false }) {
  const plans = [];
  for (const h of HARNESSES) {
    const r = resolveSkills(home, h, false);
    if (!r) continue;
    checkRemovable(r.target, force);
    plans.push(r.target);
  }
  const removed = [];
  for (const target of plans) if (removeTarget(target, force)) removed.push(target);
  return { removed };
}

/**
 * Installed harnesses and optional tools. With `root`, also the project's .ai status, with its vendored tools verified
 * against the installed skill of the first installed harness.
 */
export function doctor({ home, root }) {
  const harnesses = HARNESSES.map((h) => {
    const target = targetOf(home, h);
    const entry = { name: h.name, installed: false };
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(target, '.installed.json'), 'utf8'));
      entry.installed = true;
      entry.version = meta.version;
      entry.catalogVersion = meta.catalogVersion;
    } catch {
      if (fs.existsSync(target)) entry.partial = true;
    }
    return entry;
  });
  const graphify = HARNESSES.some((h) => fs.existsSync(path.join(home, h.dir, 'skills', 'graphify')));
  const result = { node: process.version, harnesses, optional: { graphify } };
  if (root !== undefined) result.project = projectStatus(home, root, harnesses);
  return result;
}

function projectStatus(home, root, harnesses) {
  const first = harnesses.find((h) => h.installed);
  if (!first) return { aiStatus: null, reason: 'no installed android-architect skill to verify against' };
  const skillDir = targetOf(home, HARNESSES.find((h) => h.name === first.name));
  const catalogDir = path.join(skillDir, 'catalog');
  const status = aiStatus(root, {
    toolCatalogVersion: loadCatalog(catalogDir).catalogVersion,
    skillDir,
    catalogDir,
    toolVersion: first.version,
  });
  return { harness: first.name, aiStatus: status };
}
