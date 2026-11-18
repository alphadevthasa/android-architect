import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog } from './catalog.js';

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

// Remove only the exact expected target. A symlink is unlinked, never followed.
function removeTarget(home, h) {
  const target = path.resolve(targetOf(home, h));
  const expected = path.resolve(home, h.dir, 'skills', NAME);
  if (target !== expected) throw new Error(`Refusing to remove unexpected path: ${target}`);
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (st.isSymbolicLink()) fs.unlinkSync(target);
  else if (st.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
  return true;
}

export function install({ home, claude = false, codex = false, sourceDir }) {
  const src = sourceDir instanceof URL ? sourceDir.pathname : sourceDir;
  const explicit = { claude, codex };
  let chosen = HARNESSES.filter((h) => explicit[h.name]);
  if (chosen.length === 0) {
    chosen = HARNESSES.filter((h) => fs.existsSync(path.join(home, h.dir)));
    if (chosen.length === 0) throw new NoHarnessError();
  }
  const version = readPackage().version;
  const catalogVersion = loadCatalog(path.join(src, 'catalog')).catalogVersion;
  const installed = [];
  for (const h of chosen) {
    const target = targetOf(home, h);
    removeTarget(home, h);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(src, target, { recursive: true, dereference: false });
    fs.writeFileSync(
      path.join(target, '.installed.json'),
      JSON.stringify({ version, catalogVersion, installedAt: new Date().toISOString() }, null, 2) + '\n',
    );
    installed.push(target);
  }
  return { installed };
}

export function uninstall({ home }) {
  const removed = [];
  for (const h of HARNESSES) {
    if (removeTarget(home, h)) removed.push(targetOf(home, h));
  }
  return { removed };
}

export function doctor({ home }) {
  const harnesses = HARNESSES.map((h) => {
    const target = targetOf(home, h);
    const entry = { name: h.name, installed: false };
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(target, '.installed.json'), 'utf8'));
      entry.installed = true;
      entry.version = meta.version;
      entry.catalogVersion = meta.catalogVersion;
    } catch {
      entry.installed = fs.existsSync(target);
    }
    return entry;
  });
  const graphify = HARNESSES.some((h) => fs.existsSync(path.join(home, h.dir, 'skills', 'graphify')));
  return { node: process.version, harnesses, optional: { graphify } };
}
