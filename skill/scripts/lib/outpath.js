// Guard for user-supplied --out file paths: never write through links or into the project.
import fs from 'node:fs';
import path from 'node:path';

const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Validate an --out file path and return its absolute path. Throws Error with a short message (no absolute paths).
 * Refuses: a final-component symlink, an existing non-regular file (directory, FIFO), an existing file with several
 * hard links, and (unless allowInside) any target whose real parent directory is inside the real project root.
 */
export function safeOutPath(outArg, root, { allowInside = false } = {}) {
  if (typeof outArg !== 'string' || outArg === '' || outArg.includes('\0')) throw new Error('--out needs a file path');
  const abs = path.resolve(outArg);
  let realParent;
  try {
    realParent = fs.realpathSync(path.dirname(abs));
  } catch {
    throw new Error('--out directory does not exist');
  }
  const target = path.join(realParent, path.basename(abs));
  if (!allowInside && inside(fs.realpathSync(root), realParent)) throw new Error('--out must be outside the project');
  let st = null;
  try {
    st = fs.lstatSync(target);
  } catch {
    st = null;
  }
  if (st !== null) {
    if (st.isSymbolicLink()) throw new Error('--out must not be a symbolic link');
    if (st.isDirectory()) throw new Error('--out is a directory; give a file path');
    if (!st.isFile()) throw new Error('--out must be a regular file');
    if (st.nlink > 1) throw new Error('--out must not be a hard-linked file');
  }
  return abs;
}

/**
 * Write text to a path accepted by safeOutPath: a new file with `wx`, an existing regular file truncated in place. The
 * opened descriptor is checked again (regular file, at most one link) before anything is truncated or written, so a link
 * swapped in after the checks is refused without touching its target.
 */
export function writeOut(target, text) {
  let fd;
  try {
    fd = fs.openSync(target, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw new Error('cannot write --out');
    const st = fs.lstatSync(target);
    if (!st.isFile() || st.nlink > 1) throw new Error('--out must be a regular file');
    try {
      fd = fs.openSync(target, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch {
      throw new Error('cannot write --out');
    }
  }
  try {
    const open = fs.fstatSync(fd);
    if (!open.isFile() || open.nlink > 1) throw new Error('--out must be a regular file');
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}
