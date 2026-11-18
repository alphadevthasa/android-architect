import fs from 'node:fs';
import path from 'node:path';

export const IGNORED_DIRS = ['build', '.gradle', '.git', '.idea', 'node_modules', '.ai', 'graphify-out'];

// Matched case-insensitively against file basenames (link and target). These
// files are never listed or read.
export const SECRET_FILE_PATTERNS = [
  /^local\.properties$/i,
  /^keystore\.properties$/i,
  /\.jks$/i,
  /\.keystore$/i,
  /\.p12$/i,
  /^google-services\.json$/i,
  /^\.env(\..*)?$/i,
];

function isSecret(name) {
  return SECRET_FILE_PATTERNS.some((re) => re.test(name));
}

function isInside(realRoot, p) {
  return p === realRoot || p.startsWith(realRoot + path.sep);
}

/**
 * List regular files under root as sorted POSIX-style relative paths.
 * Symlinks are followed only when their real path stays inside the real root.
 */
export function listFiles(root, opts = {}) {
  const ignored = new Set([...IGNORED_DIRS, ...(opts.extraIgnoreDirs ?? [])]);
  const realRoot = fs.realpathSync(root);
  const visited = new Set([realRoot]);
  const results = [];
  const pendingLinks = [];

  const targetIgnored = (realTarget) =>
    path.relative(realRoot, realTarget).split(path.sep).some((seg) => ignored.has(seg));

  // Walk real (non-symlink) directories, claiming each real path. Symlinks are
  // deferred so the canonical path of a directory always wins over a link path.
  const walkReal = (startAbs, startRel) => {
    const stack = [{ abs: startAbs, rel: startRel }];
    while (stack.length > 0) {
      const { abs, rel } = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const name = entry.name;
        const entryAbs = path.join(abs, name);
        const entryRel = rel ? `${rel}/${name}` : name;
        if (entry.isSymbolicLink()) {
          pendingLinks.push({ abs: entryAbs, rel: entryRel, name });
        } else if (entry.isDirectory()) {
          if (ignored.has(name)) continue;
          const real = fs.realpathSync(entryAbs);
          if (visited.has(real)) continue;
          visited.add(real);
          stack.push({ abs: entryAbs, rel: entryRel });
        } else if (entry.isFile() && !isSecret(name)) {
          results.push(entryRel);
        }
      }
    }
  };

  walkReal(root, '');
  while (pendingLinks.length > 0) {
    pendingLinks.sort((x, y) => (x.rel < y.rel ? 1 : x.rel > y.rel ? -1 : 0));
    const link = pendingLinks.pop();
    if (ignored.has(link.name)) continue;
    let real;
    let st;
    try {
      real = fs.realpathSync(link.abs);
      st = fs.statSync(real);
    } catch {
      continue; // broken link
    }
    if (!isInside(realRoot, real) || targetIgnored(real)) continue;
    if (st.isFile()) {
      if (!isSecret(link.name) && !isSecret(path.basename(real))) results.push(link.rel);
    } else if (st.isDirectory() && !visited.has(real)) {
      visited.add(real);
      walkReal(link.abs, link.rel);
    }
  }
  return results.sort();
}

/** Read a UTF-8 file as lines; index i is line i + 1. Strips a leading BOM. */
export function readLines(absPath) {
  let text = fs.readFileSync(absPath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.split(/\r?\n/);
}
