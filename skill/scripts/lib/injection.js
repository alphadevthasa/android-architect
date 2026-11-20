// Reports instruction-like text planted in .ai files that a coding agent will read. Findings are information only.
// Patterns are linear-time on purpose (no nested quantifiers, every wildcard span bounded): .ai content is user-controlled.
import fs from 'node:fs';
import path from 'node:path';

const NOUN = String.raw`\.env|token|secret|api key|credential|password|private key|keystore|contents of`;
const SINK = String.raw`(?<![^ ])(?:-d |--data|-f |-x post)|\| ?(?:curl|sh)\b`;
const ROLE = String.raw`admin|administrator|root|developer mode|dan|jailbroken|unrestricted|system`;
const SECRET_VERB = String.raw`(?:^[-+>#0-9.) ]*|[.!?:;] )(?:print|show|send|paste|reveal|output|dump) `;
const CUE = String.raw`\bto\b|\bhere\b|in (?:the )?(?:chat|reply|response|output)|the value|contents`;

// Rules run on normalized text: lowercase, markdown emphasis and backticks removed, whitespace collapsed.
const RULES = [
  {
    rule: 'override-instructions',
    re: /\b(?:ignore|disregard|forget) (?:(?:the|any|all) ){0,3}(?:previous|prior|above|earlier) (?:instructions?|rules?|guidance|directions?|prompts?)/,
  },
  { rule: 'role-change', re: new RegExp(String.raw`you are now (?:(?:a|an|the|in) )?(?:${ROLE})\b|act as (?:an? )?(?:admin|root|developer mode|system)\b`) },
  {
    rule: 'exfiltration',
    only: 'http',
    re: new RegExp(
      String.raw`\b(?:curl|wget|fetch|upload|send|post) [^\n]{0,200}?(?:${NOUN}|${SINK})[^\n]{0,200}https?://|\| ?curl [^\n]{0,200}https?://|https?://[^\n]{0,200}\| ?(?:sh|bash)\b`,
    ),
  },
  { rule: 'run-command', re: /\b(?:run|execute) (?:(?:this|the following|the|these) )?(?:commands?|scripts?|shell)\b/ },
  {
    rule: 'secret-request',
    re: new RegExp(
      String.raw`${SECRET_VERB}[^\n]{0,200}?(?:${NOUN})[^\n]{0,200}?(?:${CUE})|${SECRET_VERB}[^\n]{0,200}?(?:${CUE})[^\n]{0,200}?(?:${NOUN})`,
    ),
  },
  { rule: 'label-forcing', re: /\b(?:label|mark) (?:everything|all)(?: recommendations| items| steps)? as must(?![-\w])/ },
];
// A fenced block whose info string starts with a shell name (attributes may follow: ```bash title=x, ```{.bash}).
const SHELL_FENCE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*\{?\.?(?:sh|bash|zsh|shell|powershell|pwsh)(?=$|[\s{},])/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const normalize = (line) => line.replace(/[*_`]/g, '').replace(/\s+/g, ' ').toLowerCase();

/** Findings for one text: [{ line, rule }] (1-based lines), at most one per rule per line, sorted by line then rule. */
export function scanInstructions(text) {
  const hits = new Set();
  let fence = null;
  const lines = String(text).split('\n');
  const norm = lines.map(normalize);
  const test = (s, mark) => {
    for (const { rule, re, only } of RULES) if ((!only || s.includes(only)) && re.test(s)) mark.add(rule);
  };
  const single = norm.map((n) => {
    const set = new Set();
    test(n, set);
    return set;
  });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const found = new Set(single[i]);
    // Text split over two lines: match the joined pair too and report the first line, unless the second line alone matches.
    if (i + 1 < lines.length) {
      const pair = new Set();
      test(`${norm[i]} ${norm[i + 1]}`, pair);
      for (const rule of pair) if (!single[i + 1].has(rule)) found.add(rule);
    }
    // Only the fence rule looks at fence structure: the other rules scan fenced text too.
    const open = FENCE.exec(line);
    if (fence === null) {
      if (open) {
        fence = open[1];
        if (SHELL_FENCE.test(line)) found.add('run-command');
      }
    } else if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) {
      fence = null;
    }
    for (const rule of found) hits.add(`${i + 1}\0${rule}`);
  }
  return [...hits]
    .map((k) => {
      const [line, rule] = k.split('\0');
      return { line: Number(line), rule };
    })
    .sort((a, b) => a.line - b.line || byText(a.rule, b.rule));
}

const JSON_STRING = /"(?:[^"\\\n]|\\.)*"/g;

/** JSON files: scan string values (decoded, so escapes do not hide text), reporting the line each string starts on. */
function scanJson(text) {
  try {
    JSON.parse(text);
  } catch {
    return scanInstructions(text);
  }
  const out = [];
  let line = 1;
  let seen = 0;
  for (const m of text.matchAll(JSON_STRING)) {
    if (/^\s*:/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 64))) continue; // an object key
    for (let i = text.indexOf('\n', seen); i !== -1 && i < m.index; i = text.indexOf('\n', seen)) {
      line++;
      seen = i + 1;
    }
    const base = line;
    for (const f of scanInstructions(JSON.parse(m[0]))) out.push({ line: base + f.line - 1, rule: f.rule });
  }
  return out;
}

function mdFiles(aiDir, sub, recursive) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory() && recursive) walk(path.join(abs, e.name), r);
      else if ((e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.md')) out.push(r);
    }
  };
  walk(path.join(aiDir, sub), sub);
  return out;
}

// .ai/fitness holds generated files a user copies into the build: Markdown, JSON and Kotlin, scanned as text.
// A symlinked folder is listed itself, so it is reported as a symlink finding and not followed.
function fitnessFiles(aiDir) {
  try {
    if (fs.lstatSync(path.join(aiDir, 'fitness')).isSymbolicLink()) return ['fitness'];
    return fs.readdirSync(path.join(aiDir, 'fitness'))
      .filter((n) => ['.md', '.json', '.kt', '.kts'].some((ext) => n.endsWith(ext)))
      .sort()
      .map((n) => `fitness/${n}`);
  } catch {
    return [];
  }
}

function jsonFiles(aiDir, sub) {
  try {
    return fs.readdirSync(path.join(aiDir, sub)).filter((n) => n.endsWith('.json')).sort().map((n) => `${sub}/${n}`);
  } catch {
    return [];
  }
}

/**
 * Scan the files of .ai that a person or agent may have edited, or that a pull request may change: README.md,
 * refresh-report.md, knowledge (generated files included), migration and workflow Markdown, catalog-overrides/*.json,
 * the generated fitness files,
 * recommendations.json and repos.json. A symlink among them is a finding (rule "symlink", line 1) and is not followed.
 * Returns sorted [{ file, line, rule }] with file relative to root (".ai/...").
 */
export function scanAiDir(root) {
  const aiDir = path.join(root, '.ai');
  const files = [
    'README.md',
    'refresh-report.md',
    ...mdFiles(aiDir, 'knowledge', true),
    ...mdFiles(aiDir, 'migration', true),
    ...mdFiles(aiDir, 'workflows', false),
    ...jsonFiles(aiDir, 'catalog-overrides'),
    ...fitnessFiles(aiDir),
    'recommendations.json',
    'repos.json',
  ];
  const out = [];
  for (const rel of files) {
    let text;
    try {
      const abs = path.join(aiDir, rel);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        out.push({ file: `.ai/${rel}`, line: 1, rule: 'symlink' });
        continue;
      }
      if (!st.isFile()) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const findings = rel.endsWith('.json') ? scanJson(text) : scanInstructions(text);
    for (const f of findings) out.push({ file: `.ai/${rel}`, line: f.line, rule: f.rule });
  }
  return out.sort((a, b) => byText(a.file, b.file) || a.line - b.line || byText(a.rule, b.rule));
}
