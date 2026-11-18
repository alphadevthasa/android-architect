import fs from 'node:fs';
import path from 'node:path';

export const IGNORED_DIRS = ['build', '.gradle', '.git', '.idea', 'node_modules', '.ai', 'graphify-out'];

// Matched against file basenames. These files are never listed or read.
export const SECRET_FILE_PATTERNS = [
  /^local\.properties$/,
  /^keystore\.properties$/,
  /\.jks$/,
  /\.keystore$/,
  /\.p12$/,
  /^google-services\.json$/,
  /^\.env(\..*)?$/,
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
  const stack = [{ abs: root, rel: '' }];

  const targetIgnored = (realTarget) =>
    path.relative(realRoot, realTarget).split(path.sep).some((seg) => ignored.has(seg));

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

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let real = null;
      if (entry.isSymbolicLink()) {
        try {
          real = fs.realpathSync(entryAbs);
        } catch {
          continue; // broken link
        }
        if (!isInside(realRoot, real) || targetIgnored(real)) continue;
        const st = fs.statSync(real);
        isDir = st.isDirectory();
        isFile = st.isFile();
        if (isFile && isSecret(path.basename(real))) continue;
      }

      if (isDir) {
        if (ignored.has(name)) continue;
        if (real === null) real = fs.realpathSync(entryAbs);
        if (visited.has(real)) continue;
        visited.add(real);
        stack.push({ abs: entryAbs, rel: entryRel });
      } else if (isFile) {
        if (isSecret(name)) continue;
        results.push(entryRel);
      }
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
