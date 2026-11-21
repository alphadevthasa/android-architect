#!/usr/bin/env node
// Usage: node skill/scripts/playbook.js list [--format json|md] [--dir <playbooks>]
//        node skill/scripts/playbook.js show <id> [--format json|md] [--dir <playbooks>]
//        node skill/scripts/playbook.js apply <from> <to> <projectRoot> [--format json|md] [--dir <playbooks>]
// Lists migration playbooks and applies one to a project (read-only): is the source detected, what to cut over, what gates it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './lib/catalog.js';
import { loadCatalogWithOverrides } from './lib/overrides.js';
import { detectStack } from './lib/detect.js';
import { loadPlaybooks, validatePlaybooks, applyPlaybook, playbooksDir, SECTIONS } from './lib/playbooks.js';
import { mdText, stripUnsafe } from './lib/knowledge.js';
import { oneLine } from './lib/overrides.js';
import { redact, redactJson } from './lib/redact.js';

const USAGE = 'usage: node playbook.js list | show <id> | apply <from> <to> <projectRoot> [--format json|md] [--dir <playbooks>]';
const BUILD_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.xml'];

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function parseArgs(argv, defaults) {
  const opts = { positional: [], format: defaults.format, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format' || a === '--dir') {
      const v = argv[++i];
      if (v === undefined) fail(1, `missing value for ${a}\n${USAGE}`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith('--')) {
      fail(1, `unknown option ${a}\n${USAGE}`);
    } else {
      opts.positional.push(a);
    }
  }
  if (opts.format !== 'json' && opts.format !== 'md') fail(1, `unknown format ${opts.format}\n${USAGE}`);
  return opts;
}

// Body text keeps its line structure but loses control characters.
const body = (s) => stripUnsafe(String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''));
const summary = (p) => ({ id: p.id, dimension: p.dimension, from: p.from, to: p.to, title: p.title, irreversible: p.irreversible, kmpOnly: p.kmpOnly, verified: p.verified, asOf: p.asOf });
const pairs = (list) => (list.length === 0 ? 'no playbooks are installed' : list.map((p) => `${p.from} -> ${p.to}`).join('\n'));

function renderList(list) {
  if (list.length === 0) return '# Migration playbooks\n\nNo playbooks.\n';
  const rows = list.map((p) => `- \`${mdText(p.id)}\`: ${mdText(p.from)} -> ${mdText(p.to)}: ${mdText(p.title)}${p.verified ? '' : ' (unverified)'}`);
  return ['# Migration playbooks', '', ...rows, ''].join('\n');
}

function renderShow(p) {
  const out = [`# ${mdText(p.title)}`, '', `- id: \`${mdText(p.id)}\``, `- dimension: ${mdText(p.dimension)}`, `- ${mdText(p.from)} -> ${mdText(p.to)}`,
    `- irreversible: ${p.irreversible}; KMP only: ${p.kmpOnly}; verified: ${p.verified}; as of ${mdText(p.asOf)}`];
  if (p.worthIf.length > 0) out.push(`- worth it only if: ${p.worthIf.map(mdText).join(', ')}`);
  out.push('');
  for (const s of SECTIONS) out.push(`## ${s}`, '', body(p.sections[s]), '');
  return out.join('\n');
}

function renderApply(p, r) {
  const out = [`# Playbook: ${mdText(p.title)}`, '', `${mdText(p.from)} -> ${mdText(p.to)} (${mdText(p.dimension)})`, ''];
  if (!r.applicable) return out.concat(`Not applicable: ${mdText(r.reason)}.`, '').join('\n');
  out.push(r.worth.ok ? 'Worth it: conditions hold.' : 'Worth it: no.', '');
  for (const n of r.worth.notes) out.push(`- ${mdText(n)}`);
  if (r.worth.notes.length > 0) out.push('');
  out.push(`Tags: ${r.tags.length === 0 ? 'none' : r.tags.join(', ')}${r.gated ? ' (gated: needs a human decision)' : ''}`, '');
  const listed = r.cutoverUnits.length;
  out.push(`## Cutover units`, '', `${listed + r.moreUnits} cutover files (profile counts ${r.totalUnits} units)`, '');
  if (listed === 0) out.push('none');
  else {
    out.push('| File | Line | Module |', '| --- | --- | --- |');
    for (const u of r.cutoverUnits) out.push(`| ${mdText(u.file)} | ${u.line ?? '-'} | ${mdText(u.module ?? '-')} |`);
    if (r.moreUnits > 0) out.push('', `... and ${r.moreUnits} more`);
  }
  if (r.buildFiles.length > 0) {
    out.push('', '## Build files to update', '');
    for (const f of r.buildFiles) out.push(`- ${mdText(f)}`);
    if (r.moreBuildFiles > 0) out.push(`- ... and ${r.moreBuildFiles} more`);
  }
  out.push('', '## Security checklist', '');
  for (const c of r.securityChecklist) out.push(`- ${mdText(c)}`);
  return out.concat('').join('\n');
}

export function main(argv, { playbooksDir: dirOpt } = {}) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'list' && cmd !== 'show' && cmd !== 'apply') fail(1, USAGE);
  const opts = parseArgs(rest, { format: cmd === 'apply' ? 'json' : 'md' });
  const need = cmd === 'list' ? 0 : cmd === 'show' ? 1 : 3;
  if (opts.positional.length !== need) fail(1, USAGE);
  const dir = opts.dir !== null ? path.resolve(opts.dir) : dirOpt ?? fileURLToPath(playbooksDir);

  if (opts.dir === null && dirOpt === undefined && !fs.existsSync(dir)) {
    fail(1, 'the playbooks are not vendored into .ai/tools; run playbook.js from the installed skill (npx android-architect), not from a vendored copy');
  }
  let list;
  try {
    list = loadPlaybooks(dir);
    const errs = validatePlaybooks(list, loadCatalog());
    if (errs.length > 0) throw new Error(errs.join('\n'));
  } catch (e) {
    fail(1, redact(String(e.message)).text);
  }
  const print = (text) => process.stdout.write(redact(text).text);

  if (cmd === 'list') {
    print(opts.format === 'md' ? renderList(list) : JSON.stringify(redactJson(list.map(summary)), null, 2) + '\n');
    return;
  }
  if (cmd === 'show') {
    const p = list.find((x) => x.id === opts.positional[0]);
    if (p === undefined) fail(1, `unknown playbook ${redact(oneLine(opts.positional[0])).text}\nknown playbooks:\n${list.map((x) => x.id).join('\n')}`);
    print(opts.format === 'md' ? renderShow(p) : JSON.stringify(redactJson(p), null, 2) + '\n');
    return;
  }

  const [from, to, rootArg] = opts.positional;
  const pb = list.find((x) => x.from === from && x.to === to);
  if (pb === undefined) fail(1, `unknown pair ${redact(oneLine(from)).text} -> ${redact(oneLine(to)).text}\nknown pairs:\n${pairs(list)}`);
  const root = path.resolve(rootArg);
  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir || !BUILD_FILES.some((f) => fs.existsSync(path.join(root, f)))) fail(2, `not an Android/Gradle project: ${redact(oneLine(rootArg)).text}`);
  let result;
  try {
    const catalog = loadCatalogWithOverrides(undefined, root).catalog;
    result = applyPlaybook(pb, detectStack(root, catalog), catalog, { root });
  } catch (e) {
    fail(1, redact(String(e.message)).text);
  }
  print(opts.format === 'md' ? renderApply(pb, result) : JSON.stringify(redactJson({ playbook: summary(pb), ...result }), null, 2) + '\n');
}

const isMain = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (process.argv[1] && isMain()) {
  main(process.argv.slice(2));
}
