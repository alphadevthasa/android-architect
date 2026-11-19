import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/**
 * Hash every regular file under dir. Keys are POSIX paths relative to `base`
 * (default `dir`), e.g. hashTree('<ai>/tools', '<ai>') gives 'tools/scripts/x.js'.
 * Throws on symlinks. Keys are sorted.
 */
export function hashTree(dir, base = dir) {
  const out = {};
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`refusing symlink: ${p}`);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out[path.relative(base, p).split(path.sep).join('/')] = sha256File(p);
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Every regular file under dir as a sorted POSIX path relative to dir. Throws on symlinks. */
export function regularFiles(dir) {
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
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
