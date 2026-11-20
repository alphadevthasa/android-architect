// Markdown-safe text helpers for untrusted strings (file paths, evidence) printed into generated Markdown.

/** Removes Unicode bidi controls and line/paragraph separators (they can visually reorder or forge lines). */
export const stripUnsafe = (s) => String(s).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, ' ');

/**
 * One line of Markdown-safe text: whitespace collapsed, pipes and square brackets escaped (no table cell breaks, no
 * links or images), no leading heading, quote or list marker.
 */
export const mdText = (s) => {
  const t = stripUnsafe(s)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[\s\u2028\u2029]+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|')
    .replace(/[[\]]/g, (c) => `\\${c}`)
    .replace(/</g, '&lt;')
    .replace(/`/g, "'");
  return /^[#>-]/.test(t) ? '\\' + t : t;
};
