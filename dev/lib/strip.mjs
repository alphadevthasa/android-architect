// Allowlist strip for fetched eval apps (maintainer-only; not packaged). node --test discovery executes any
// js/mjs/cjs/ts/... file under test/, so a fetched app must not keep anything the scan does not read.
// Kept: regular files whose extension the scan reads (detect.js READABLE_EXT: .java .kt .kts .gradle .xml .toml
// .properties .pro) plus .yml/.yaml (detekt config signals), .editorconfig, .gitignore (the scan honours it),
// README* and LICENSE*. Everything else is deleted: scripts, ts/js, symlinks, binaries, .github, .gitmodules.
// The .git directory is kept except its hooks directory.
import fs from 'node:fs';
import path from 'node:path';

export const NODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);
const KEEP_EXTS = new Set(['.java', '.kt', '.kts', '.gradle', '.xml', '.toml', '.properties', '.pro', '.yml', '.yaml']);
const KEEP_NAMES = new Set(['.editorconfig', '.gitignore']);

export function keepName(name) {
  if (KEEP_NAMES.has(name)) return true;
  const upper = name.toUpperCase();
  if (upper.startsWith('README') || upper.startsWith('LICENSE')) return true;
  return KEEP_EXTS.has(path.extname(name).toLowerCase());
}

export function stripToAllowlist(dir) {
  fs.rmSync(path.join(dir, '.git', 'hooks'), { recursive: true, force: true });
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (d === dir && e.name === '.git') continue;
      if (e.isSymbolicLink()) fs.unlinkSync(p); // rmSync mishandles symlinks on some Node 24 builds
      else if (e.isDirectory()) walk(p);
      else if (!e.isFile() || !keepName(e.name)) fs.rmSync(p, { force: true });
    }
  };
  walk(dir);
}

/** Relative paths of files a node test run could execute (by extension); detective check used by the eval. */
export function findNodeDiscoverable(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (rel === '' && e.name === '.git') continue;
      const p = path.join(d, e.name);
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else if (NODE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}
