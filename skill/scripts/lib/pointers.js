import fs from 'node:fs';
import path from 'node:path';

export const POINTER_MARKER = '<!-- android-architect:pointer -->';

const sortByFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

/**
 * Apply the pointer block to AGENTS.md / CLAUDE.md (committed mode) or CLAUDE.local.md (local mode).
 * `write(rel, content)` is the caller's guarded writer. Returns [{file, action}] sorted by file.
 */
export function applyPointers(root, { local, appendPointers, block, write }) {
  const text = block.endsWith('\n') ? block : block + '\n';
  const results = [];
  const apply = (file, onExistingWithoutMarker) => {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) {
      write(file, text);
      return 'created';
    }
    const current = fs.readFileSync(abs, 'utf8');
    if (current.includes(POINTER_MARKER)) return 'present';
    if (!onExistingWithoutMarker) return 'needs-confirmation';
    write(file, current + (current === '' || current.endsWith('\n') ? '' : '\n') + '\n' + text);
    return 'appended';
  };
  if (local) {
    results.push({ file: 'AGENTS.md', action: 'skipped-local' }, { file: 'CLAUDE.md', action: 'skipped-local' });
    results.push({ file: 'CLAUDE.local.md', action: apply('CLAUDE.local.md', true) });
  } else {
    for (const file of ['AGENTS.md', 'CLAUDE.md']) results.push({ file, action: apply(file, appendPointers) });
  }
  return results.sort(sortByFile);
}
