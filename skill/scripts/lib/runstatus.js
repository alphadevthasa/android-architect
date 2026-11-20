// The agent's final status contract. Agent output is untrusted: the status is only read from a block whose markers sit
// alone on their lines, the LAST complete block wins, and the scan uses lastIndexOf only (linear, no regexes).
export const STATUS_START = '<<<STATUS';
export const STATUS_END = 'STATUS>>>';
const STATUSES = ['done', 'blocked', 'needs-human', 'failed'];
const KEYS = ['step', 'status', 'summary', 'filesChanged', 'verification'];
const MAX_TEXT = 2000;
const MAX_FILES = 200;
const MAX_PATH = 300;
const MAX_BLOCK = 256 * 1024;

import { stripUnsafe } from './mdtext.js';

/** Text without control characters (newline and tab stay) and without bidi controls. */
const cleanText = (s) => {
  let out = '';
  for (const ch of stripUnsafe(s)) {
    const c = ch.charCodeAt(0);
    if (c === 10 || c === 9 || (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f))) out += ch;
  }
  return out;
};

/** A changed-file path: relative, no ".." segment, no control characters, not starting with "-". */
const validPath = (f) => {
  if (f.length === 0 || f.length > MAX_PATH || f.startsWith('-') || f.startsWith('/') || f.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(f)) return false;
  for (let i = 0; i < f.length; i++) {
    const c = f.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return !f.split(/[\\/]/).some((seg) => seg === '..');
};

const fail = (reason) => ({ ok: false, reason });

/** True when the marker found at `at` is alone on its line (only a CR may follow it). */
function aloneOnLine(raw, at, len) {
  if (at > 0 && raw[at - 1] !== '\n') return false;
  const after = at + len;
  if (after === raw.length || raw[after] === '\n') return true;
  return raw[after] === '\r' && (after + 1 === raw.length || raw[after + 1] === '\n');
}

function lastMarker(raw, marker, from) {
  let at = raw.lastIndexOf(marker, from);
  while (at !== -1 && !aloneOnLine(raw, at, marker.length)) at = at === 0 ? -1 : raw.lastIndexOf(marker, at - 1);
  return at;
}

/**
 * Parses the agent's output for its status block. Returns { ok: true, status } or { ok: false, reason }. `status` is
 * { step, status, summary, filesChanged, verification }; `step` must equal expectedStepId.
 */
export function parseStatus(raw, expectedStepId) {
  if (typeof raw !== 'string') return fail('output is not text');
  const end = lastMarker(raw, STATUS_END, raw.length);
  if (end === -1) return fail('no status block');
  const start = end === 0 ? -1 : lastMarker(raw, STATUS_START, end - 1);
  if (start === -1) return fail('no status block');
  const bodyFrom = start + STATUS_START.length;
  if (end - bodyFrom > MAX_BLOCK) return fail('status block is too large');
  let value;
  try {
    value = JSON.parse(raw.slice(bodyFrom, end));
  } catch {
    return fail('status block is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('status must be a JSON object');
  for (const k of Object.keys(value)) if (!KEYS.includes(k)) return fail('status has an unexpected key');
  for (const k of KEYS) if (!Object.hasOwn(value, k)) return fail(`status is missing "${k}"`);
  if (typeof value.step !== 'string' || value.step !== expectedStepId) return fail('status is for a different step');
  if (!STATUSES.includes(value.status)) return fail('status value is not one of done, blocked, needs-human, failed');
  if (typeof value.summary !== 'string' || value.summary.length > MAX_TEXT) return fail(`summary must be text of at most ${MAX_TEXT} characters`);
  if (typeof value.verification !== 'string' || value.verification.length > MAX_TEXT) return fail(`verification must be text of at most ${MAX_TEXT} characters`);
  if (!Array.isArray(value.filesChanged) || value.filesChanged.length > MAX_FILES) return fail(`filesChanged must be a list of at most ${MAX_FILES} paths`);
  for (const f of value.filesChanged) if (typeof f !== 'string' || !validPath(f)) return fail('filesChanged entries must be relative paths without "..", control characters or a leading "-"');
  const { step, status, summary, filesChanged, verification } = value;
  return { ok: true, status: { step, status, summary: cleanText(summary), filesChanged: [...filesChanged], verification: cleanText(verification) } };
}
