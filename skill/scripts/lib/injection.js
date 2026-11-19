// Reports instruction-like text planted in .ai files that a coding agent will read. Findings are information only.
// Patterns are linear-time on purpose (no nested quantifiers, every wildcard span bounded): .ai content is user-controlled.
import fs from 'node:fs';
import path from 'node:path';
import { GENERATED_KNOWLEDGE } from './aidir.js';

const RULES = [
  { rule: 'override-instructions', re: /ignore (?:all )?(?:previous|prior|above) (?:instructions|rules)|disregard [^\n]{0,200}(?:instructions|rules)/i },
  { rule: 'role-change', re: /you are now|act as (?:an? )?(?:admin|root|developer mode)/i },
  { rule: 'exfiltration', re: /\b(?:curl|wget|fetch|upload|send|post) [^\n]{0,200}https?:\/\//i },
  { rule: 'run-command', re: /\b(?:run|execute) (?:this |the following )?(?:command|script|shell)/i },
  { rule: 'secret-request', re: /\b(?:print|show|send|paste) [^\n]{0,200}(?:token|password|secret|api key|\.env)/i },
  { rule: 'label-forcing', re: /\b(?:label|mark) (?:everything|all) (?:as )?must/i },
];
const SHELL_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(sh|bash|zsh|powershell)[ \t]*$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Findings for one text: [{ line, rule }] (1-based lines), at most one per rule per line, sorted by line then rule. */
export function scanInstructions(text) {
  const out = [];
  let fence = null;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hits = new Set();
    for (const { rule, re } of RULES) if (re.test(line)) hits.add(rule);
    // Only the fence rule looks at fence structure: the other rules above scan fenced text too.
    const open = FENCE.exec(line);
    if (fence === null) {
      if (open) {
        fence = open[1];
        if (SHELL_FENCE.test(line)) hits.add('run-command');
      }
    } else if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) {
      fence = null;
    }
    for (const rule of hits) out.push({ line: i + 1, rule });
  }
  return out.sort((a, b) => a.line - b.line || byText(a.rule, b.rule));
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
      else if (e.isFile() && e.name.endsWith('.md')) out.push(r);
    }
  };
  walk(path.join(aiDir, sub), sub);
  return out;
}

/**
 * Scan the files of .ai that a person or agent may have edited: knowledge, migration and workflow Markdown,
 * recommendations.json and repos.json. Generated knowledge files are skipped. Returns sorted [{ file, line, rule }]
 * with file relative to root (".ai/...").
 */
export function scanAiDir(root) {
  const aiDir = path.join(root, '.ai');
  const files = [
    ...mdFiles(aiDir, 'knowledge', true).filter((f) => !GENERATED_KNOWLEDGE.includes(f)),
    ...mdFiles(aiDir, 'migration', true),
    ...mdFiles(aiDir, 'workflows', false),
    'recommendations.json',
    'repos.json',
  ];
  const out = [];
  for (const rel of files) {
    let text;
    try {
      const abs = path.join(aiDir, rel);
      if (!fs.lstatSync(abs).isFile()) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const findings = rel.endsWith('.json') ? scanJson(text) : scanInstructions(text);
    for (const f of findings) out.push({ file: `.ai/${rel}`, line: f.line, rule: f.rule });
  }
  return out.sort((a, b) => byText(a.file, b.file) || a.line - b.line || byText(a.rule, b.rule));
}
