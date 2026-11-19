import fs from 'node:fs';
import path from 'node:path';
import { listFiles, readLines } from './walk.js';
import { discoverModules } from './modules.js';
import { tokenize } from './tokenize.js';
import { redact } from './redact.js';
import { buildBm25, scoreBm25 } from './bm25.js';

const K1 = 1.2;
const B = 0.75;
const MAX_FILE_BYTES = 1024 * 1024;
const DECL_RE =
  /^\s*(?:(?:public|private|internal|protected|abstract|open|final|sealed|data|enum|inline|value|annotation|static|suspend|override)\s+)*(class|interface|object|fun|enum)\s+([A-Za-z_]\w*)/;
const HEADING_RE = /^(#{1,3})\s+(.*\S)\s*$/;

function smallEnough(abs) {
  try {
    const st = fs.statSync(abs);
    return st.isFile() && st.size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

/** Lines of a text with secrets replaced by placeholders (line numbers are preserved). */
const redactLines = (lines) => redact(lines.join('\n')).text.split('\n');
const tokenizeSafe = (text) => tokenize(redact(text).text);

function sourceUnits(rel, lines) {
  lines = redactLines(lines);
  const fileTokens = [...tokenizeSafe(path.posix.basename(rel))];
  const decls = [];
  lines.forEach((text, i) => {
    const pkg = /^\s*package\s+([\w.]+)/.exec(text);
    if (pkg) fileTokens.push(...tokenize(pkg[1]));
    const imp = /^\s*import\s+([\w.]+)/.exec(text);
    if (imp) fileTokens.push(...tokenize(imp[1]));
    const d = DECL_RE.exec(text);
    if (d) decls.push({ name: d[2], line: i + 1 });
  });
  if (decls.length === 0) return [{ title: path.posix.basename(rel), line: 1, tokens: fileTokens }];
  return decls.map((d) => ({ title: d.name, line: d.line, tokens: [...tokenize(d.name), ...fileTokens] }));
}

function markdownUnits(rel, lines) {
  lines = redactLines(lines);
  const units = [];
  let cur = null;
  let fence = false;
  lines.forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) fence = !fence;
    const h = !fence && HEADING_RE.exec(text);
    if (h) {
      cur = { title: h[2], line: i + 1, tokens: tokenize(h[2]) };
      units.push(cur);
    } else if (cur) {
      cur.tokens.push(...tokenize(text));
    }
  });
  return units;
}

function gradleUnit(m) {
  const tokens = [];
  for (const p of m.build.plugins) tokens.push(...tokenizeSafe(p.id));
  for (const d of m.build.dependencies) {
    for (const part of [d.group, d.name, d.alias]) if (part) tokens.push(...tokenizeSafe(part));
  }
  return { title: m.path, line: 1, tokens };
}

function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Files under `.ai/knowledge` (never followed through a symlinked `.ai` or `.ai/knowledge`). */
function knowledgeFiles(root) {
  const ai = path.join(root, '.ai');
  const dir = path.join(ai, 'knowledge');
  if (isSymlink(ai) || isSymlink(dir)) return [];
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  return isDir ? listFiles(dir).map((f) => `.ai/knowledge/${f}`) : [];
}

export function buildIndex(root, { now = new Date(), commit = null, catalogVersion = null } = {}) {
  const files = listFiles(root);
  const entries = []; // {id, kind, path, line, title, tokens}
  const add = (kind, rel, units) => {
    for (const u of units) {
      entries.push({ id: String(entries.length), kind, path: rel, line: u.line, title: u.title, tokens: u.tokens });
    }
  };

  for (const m of discoverModules(root, files)) {
    if (m.buildFile && smallEnough(path.join(root, m.buildFile))) add('gradle', m.buildFile, [gradleUnit(m)]);
  }

  const docFiles = [
    ...files.filter((f) => /\.md$/i.test(f) && (f === 'README.md' || f.startsWith('docs/'))),
    ...knowledgeFiles(root).filter((f) => /\.md$/i.test(f)),
  ];
  for (const rel of [...new Set(files.filter((f) => /\.(kt|java)$/.test(f)))]) {
    const abs = path.join(root, rel);
    if (smallEnough(abs)) add('source', rel, sourceUnits(rel, readLines(abs)));
  }
  for (const rel of docFiles) {
    const abs = path.join(root, rel);
    if (smallEnough(abs)) add('doc', rel, markdownUnits(rel, readLines(abs)));
  }

  const model = buildBm25(entries.map((e) => ({ id: e.id, tokens: e.tokens })));
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    commit,
    catalogVersion,
    params: { k1: K1, b: B },
    avgdl: model.avgdl,
    df: model.df,
    docs: entries.map((e, i) => ({
      id: e.id,
      kind: e.kind,
      path: redact(e.path).text,
      line: e.line,
      title: redact(e.title).text,
      len: model.docs[i].len,
      tf: model.docs[i].tf,
    })),
  };
}

export function queryIndex(index, query, { limit = 10, kind } = {}) {
  const byId = new Map(index.docs.map((d) => [d.id, d]));
  const scored = scoreBm25(index, tokenize(query), index.params);
  const hits = [];
  for (const { id, score } of scored) {
    const d = byId.get(id);
    if (kind && d.kind !== kind) continue;
    hits.push({ path: d.path, line: d.line, kind: d.kind, title: d.title, score: Math.round(score * 1000) / 1000 });
    if (hits.length >= limit) break;
  }
  return hits;
}
