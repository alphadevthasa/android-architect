// Plan state of the run loop: .ai/migration/plan.json (structure) joined with .ai/migration/roadmap.md (status, which
// the user also edits). Both files are untrusted input: parsing is line based and linear, ids are checked against the
// id grammar before use, and a status edit changes one table cell through the guarded writer.
import fs from 'node:fs';
import path from 'node:path';
import { checkPlan } from './migplan.js';
import { writeAiFiles } from './aidir.js';

export const PLAN_FILE = '.ai/migration/plan.json';
export const ROADMAP_FILE = '.ai/migration/roadmap.md';
export const STATUSES = ['todo', 'doing', 'done'];
const GATED = ['irreversible', 'decision'];
const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_ROADMAP_BYTES = 4 * 1024 * 1024;
const MAX_ID = 200;
const HEADER = '| Step | Description | Status |';
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789:_.-';

export const isStepId = (id) => {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID) return false;
  for (const ch of id) if (!ID_CHARS.includes(ch)) return false;
  return true;
};

const isSeparatorRow = (line) => line.startsWith('|') && [...line].every((c) => c === '|' || c === ' ' || c === '-' || c === ':') && line.includes('-');

/** Row scan shared by parseRoadmap and setStatus. Rows: { id, desc, status (raw cell), cellStart, cellEnd, line (1-based), index }. */
function scanRoadmap(markdown) {
  const lines = String(markdown).split('\n');
  const rows = [];
  const errors = [];
  const head = lines.findIndex((l) => l.trim() === HEADER);
  if (head === -1) return { rows, errors: ['roadmap table header not found'], lines };
  let i = head + 1;
  if (i < lines.length && isSeparatorRow(lines[i].trim())) i++;
  for (; i < lines.length; i++) {
    const text = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    if (!text.startsWith('|')) break;
    const n = i + 1;
    const idEnd = text.startsWith('| `') ? text.indexOf('` | ', 3) : -1;
    const trimmed = text.trimEnd();
    const sep = trimmed.lastIndexOf(' | ');
    if (idEnd === -1 || sep <= idEnd + 2 || !trimmed.endsWith(' |') || sep + 3 > trimmed.length - 2) {
      errors.push(`roadmap line ${n}: row does not match "| \`id\` | description | status |"`);
      continue;
    }
    const id = text.slice(3, idEnd);
    if (!isStepId(id)) {
      errors.push(`roadmap line ${n}: invalid step id`);
      continue;
    }
    rows.push({ id, desc: text.slice(idEnd + 4, sep), status: trimmed.slice(sep + 3, trimmed.length - 2).trim(), cellStart: sep + 3, cellEnd: trimmed.length - 2, line: n, index: i });
  }
  return { rows, errors, lines };
}

const TITLE_CUTS = [' [irreversible]', ' [decision]', ' [no playbook]', ' (after: '];

/**
 * Reads the table renderRoadmap writes. Returns { steps: [{ id, title, tags, status, line }], errors }. Everything outside
 * the table is ignored; a row that does not match, repeats an id or has an unknown status is reported and left out.
 */
export function parseRoadmap(markdown) {
  const { rows, errors } = scanRoadmap(markdown);
  const steps = [];
  const seen = new Set();
  for (const r of rows) {
    const status = r.status.toLowerCase();
    if (!STATUSES.includes(status)) {
      errors.push(`roadmap line ${r.line}: unknown status (use todo, doing or done)`);
      continue;
    }
    if (seen.has(r.id)) {
      errors.push(`roadmap line ${r.line}: duplicate step id ${r.id}`);
      continue;
    }
    seen.add(r.id);
    // Brackets in titles are escaped by mdText, so a bare "[irreversible]" can only come from a tag.
    const tags = GATED.filter((t) => r.desc.includes(`[${t}]`));
    let cut = r.desc.length;
    for (const c of TITLE_CUTS) {
      const at = r.desc.indexOf(c);
      if (at !== -1 && at < cut) cut = at;
    }
    steps.push({ id: r.id, title: r.desc.slice(0, cut).trim(), tags, status, line: r.line });
  }
  return { steps, errors };
}

function readRegular(root, rel, maxBytes) {
  const abs = path.join(root, rel);
  let st;
  try {
    // No component under the project may be a symlink (the writer refuses the same).
    let cur = root;
    for (const part of rel.split('/').slice(0, -1)) {
      cur = path.join(cur, part);
      if (fs.lstatSync(cur).isSymbolicLink()) throw Object.assign(new Error('symlink'), { code: 'ESYMLINK' });
    }
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ESYMLINK') throw new Error(`${rel}: must be a regular file (symlinks are not followed)`);
    throw new Error(`${rel}: cannot be read (${err.code ?? 'error'})`);
  }
  if (!st.isFile()) throw new Error(`${rel}: must be a regular file (symlinks are not followed)`);
  if (st.size > maxBytes) throw new Error(`${rel}: is larger than ${maxBytes} bytes`);
  return fs.readFileSync(abs, 'utf8');
}

/**
 * Loads the plan: plan.json (checked with checkPlan) joined with the roadmap statuses by step id. Throws an Error listing
 * the problems (file-prefixed) when a file is missing or invalid, a roadmap row has no plan step or the reverse.
 * Returns { schemaVersion, steps: [{ ...planStep, tags, status, line }], tracks, notes }; tags are the union of both files.
 */
export function loadPlan(root) {
  const planText = readRegular(root, PLAN_FILE, MAX_PLAN_BYTES);
  if (planText === null) throw new Error(`${PLAN_FILE}: not found (run migration-plan.js --write first)`);
  let plan;
  try {
    plan = JSON.parse(planText);
  } catch {
    throw new Error(`${PLAN_FILE}: is not valid JSON`);
  }
  const problems = checkPlan(plan).map((p) => `${PLAN_FILE}: ${p}`);
  if (problems.length > 0) throw new Error(problems.slice(0, 10).join('\n'));
  const roadmapText = readRegular(root, ROADMAP_FILE, MAX_ROADMAP_BYTES);
  if (roadmapText === null) throw new Error(`${ROADMAP_FILE}: not found`);
  const parsed = parseRoadmap(roadmapText);
  const errs = parsed.errors.map((e) => `${ROADMAP_FILE}: ${e}`);
  const rows = new Map(parsed.steps.map((s) => [s.id, s]));
  const ids = new Set(plan.steps.map((s) => s.id));
  for (const s of plan.steps) if (!rows.has(s.id)) errs.push(`${ROADMAP_FILE}: no row for plan step ${s.id}`);
  for (const id of rows.keys()) if (!ids.has(id)) errs.push(`${ROADMAP_FILE}: row ${id} has no step in ${PLAN_FILE}`);
  if (errs.length > 0) throw new Error(errs.slice(0, 10).join('\n'));
  const steps = plan.steps.map((s) => {
    const row = rows.get(s.id);
    return { ...s, tags: [...new Set([...s.tags, ...row.tags])], status: row.status, line: row.line };
  });
  return { schemaVersion: 1, steps, tracks: plan.tracks, notes: plan.notes };
}

const isGated = (s) => s.tags.some((t) => GATED.includes(t));

/**
 * The next step to run: the first `todo` step in plan order whose dependencies are all `done` and that is not gated and
 * not in `skip` (ids that failed or stopped in this run: they and their dependents do not run, independent steps do).
 * Without one: { gated } (todo gated steps whose dependencies are done, waiting for a human), else { blocked } (every
 * remaining step), else { done: true }.
 */
export function nextRunnable(plan, { skip = new Set() } = {}) {
  const status = new Map(plan.steps.map((s) => [s.id, s.status]));
  const depsDone = (s) => s.dependsOn.every((d) => status.get(d) === 'done');
  const remaining = plan.steps.filter((s) => s.status !== 'done');
  if (remaining.length === 0) return { done: true };
  const ready = remaining.filter((s) => s.status === 'todo' && !skip.has(s.id) && depsDone(s));
  const runnable = ready.find((s) => !isGated(s));
  if (runnable) return { step: runnable, reason: runnable.dependsOn.length === 0 ? 'first todo step with no dependencies' : 'first todo step with all dependencies done' };
  const gated = ready.filter(isGated);
  if (gated.length > 0) return { gated };
  return { blocked: remaining };
}

/**
 * Rewrites only the Status cell of the roadmap row for `id` (exact match on the backticked id) and writes the file through
 * the guarded writer, atomically and without touching any other byte. `expect` (a status string, or { expect }) makes it
 * refuse unless the row currently has exactly that status. Returns { previous }.
 */
export function setStatus(root, id, status, expect) {
  if (expect !== null && typeof expect === 'object') expect = expect.expect;
  if (!isStepId(id)) throw new Error('invalid step id');
  if (!STATUSES.includes(status)) throw new Error('status must be todo, doing or done');
  if (expect !== undefined && !STATUSES.includes(expect)) throw new Error('expected status must be todo, doing or done');
  const text = readRegular(root, ROADMAP_FILE, MAX_ROADMAP_BYTES);
  if (text === null) throw new Error(`${ROADMAP_FILE}: not found`);
  const { rows, lines } = scanRoadmap(text);
  const matches = rows.filter((r) => r.id === id);
  if (matches.length !== 1) throw new Error(`${ROADMAP_FILE}: ${matches.length === 0 ? 'no row for' : 'duplicate rows for'} step ${id}`);
  const row = matches[0];
  const previous = row.status.toLowerCase();
  if (!STATUSES.includes(previous)) throw new Error(`${ROADMAP_FILE}: step ${id} has an unknown status`);
  if (expect !== undefined && previous !== expect) throw new Error(`${ROADMAP_FILE}: step ${id} is ${previous}, expected ${expect}`);
  if (row.status === status) return { previous };
  const line = lines[row.index];
  // Keep the cell's own padding: replace the trimmed status text only.
  const cell = line.slice(row.cellStart, row.cellEnd);
  const lead = cell.length - cell.trimStart().length;
  lines[row.index] = line.slice(0, row.cellStart + lead) + status + line.slice(row.cellStart + lead + cell.trim().length);
  writeAiFiles(root, { 'migration/roadmap.md': lines.join('\n') }, { redactText: false });
  return { previous };
}
