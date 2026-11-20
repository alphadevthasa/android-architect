#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { install, uninstall, update, doctor, NoHarnessError } from '../skill/scripts/lib/install.js';
import path from 'node:path';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';
import { initProject, isGradleProject } from '../skill/scripts/lib/init.js';
import { refreshAiDir } from '../skill/scripts/lib/refresh.js';

const USAGE = `Usage: android-architect <install|uninstall|update|init|refresh|doctor|version|run> [--claude] [--codex] [--force] [--home <dir>] [--json] [--root <dir>] [--local] [--append-pointers] [--workspace [paths...]]
       android-architect run [--root <dir>] [--json] [--dry-run] [--approve-build-changes <hash>]...   (run --help for details and exit codes)`;
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const sourceDir = fileURLToPath(new URL('../skill', import.meta.url));

const BOOLEAN_FLAGS = ['claude', 'codex', 'force', 'json', 'local', 'append-pointers'];
const VALUE_FLAGS = ['home', 'root'];

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}

// `run` has its own strict parser (skill/scripts/run.js: boolean flags json, dry-run, help; value flags root and the
// repeatable approve-build-changes); everything after `run` is handed over untouched.
function parseArgs(argv) {
  if (argv[0] === 'run') return { cmd: 'run', flags: new Set(), values: {}, workspace: null, rest: argv.slice(1) };
  const opts = { cmd: argv[0], flags: new Set(), values: {}, workspace: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) usageError(`Unexpected argument ${a}`);
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) opts.flags.add(name);
    else if (VALUE_FLAGS.includes(name)) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) usageError(`--${name} needs a directory value`);
      opts.values[name] = v;
      i++;
    } else if (name === 'workspace') {
      opts.workspace = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.workspace.push(argv[++i]);
    } else usageError(`Unknown option ${a}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const cmd = opts.cmd;
const flag = (n) => opts.flags.has(n);
const home = opts.values.home ?? os.homedir();

function projectRoot() {
  const root = path.resolve(opts.values.root ?? process.cwd());
  if (!isGradleProject(root)) throw new Error(`not an Android/Gradle project: ${root}`);
  return root;
}

const SUSPICIOUS_SHOWN = 10;

/** `suspicious: N (file:line rule, ...)`, or null when there are none. */
function suspiciousLine(findings) {
  if (!findings?.length) return null;
  const shown = findings.slice(0, SUSPICIOUS_SHOWN).map((f) => `${f.file}:${f.line} ${f.rule}`);
  if (findings.length > SUSPICIOUS_SHOWN) shown.push(`... ${findings.length - SUSPICIOUS_SHOWN} more`);
  return `suspicious: ${findings.length} (${shown.join(', ')})`;
}

function summarize(label, r) {
  const lines = [`${label}${r.written.length} written, ${r.kept.length} kept (yours, untouched), ${r.conflicts.length} conflicts`];
  for (const c of r.conflicts) lines.push(`  conflict: ${c} (see the .new file next to it)`);
  const sus = suspiciousLine(r.suspicious);
  if (sus) lines.push(sus);
  const pending = r.pointers.filter((p) => p.action === 'needs-confirmation');
  if (pending.length) {
    lines.push(`Pointer files left unchanged (they already exist): ${pending.map((p) => p.file).join(', ')}`);
    lines.push('To add the pointer block, run: npx android-architect init --append-pointers');
  }
  if (r.excluded.length) lines.push(`Excluded locally: ${r.excluded.join(', ')}`);
  return lines.join('\n');
}

function printRefresh(r) {
  const out = [`Tool: ${r.tool.from} -> ${r.tool.to}`, `Catalog: ${r.catalog.from} -> ${r.catalog.to}`, '', 'Candidates:'];
  const dims = Object.keys(r.candidates);
  if (!dims.length) out.push('  no changes');
  for (const d of dims) out.push(`  ${d}: added [${r.candidates[d].added.join(', ')}]; removed [${r.candidates[d].removed.join(', ')}]`);
  out.push('', 'Recommendations:');
  if (r.recommendations === null) out.push('  no .ai/recommendations.json');
  else {
    const rec = r.recommendations;
    if (!rec.violations.length && !rec.statusChanges.length && !rec.newOptions.length) out.push('  no changes');
    for (const v of rec.violations) out.push(`  violation ${v.rule}: ${v.message}`);
    for (const c of rec.statusChanges) out.push(`  ${c.dimension}.${c.id}: ${c.from} -> ${c.to}`);
    for (const o of rec.newOptions) out.push(`  ${o.dimension}.${o.target}: new successors [${o.successors.join(', ')}]`);
  }
  out.push('', 'Reopened rejections:');
  if (!r.rejections.reopened.length) out.push('  none');
  for (const x of r.rejections.reopened) out.push(`  ${x.dimension}.${x.target} can be reopened (${x.condition}), see ${x.adr.file}`);
  out.push('', `Files: ${r.files.written.length} written, ${r.files.kept.length} kept, ${r.files.conflicts.length} conflicts`);
  for (const n of r.notes) out.push(`Note: ${n}`);
  console.log(out.join('\n'));
}

function printProject(p) {
  const s = p.aiStatus;
  if (s === null) {
    console.log(`tools: unverifiable (${p.reason})`);
    return;
  }
  if (s.manifest === null) {
    console.log('project: no .ai/manifest.json (run init first)');
    return;
  }
  console.log(`project: ${s.ok ? 'up to date' : `stale (${s.stale.join(', ')})`}`);
  const t = s.tools;
  const n = t.changed.length + t.added.length + t.removed.length;
  if (t.status === 'modified') console.log(`tools: modified (${n} files)`);
  else if (t.status === 'unverifiable') console.log(`tools: unverifiable (${t.reason})`);
  else console.log('tools: ok');
  const sus = suspiciousLine(s.suspicious);
  if (sus) console.log(sus);
}

try {
  switch (cmd) {
    case 'install': {
      const { installed } = install({ home, claude: flag('claude'), codex: flag('codex'), force: flag('force'), sourceDir });
      for (const t of installed) console.log(`Installed to ${t}`);
      break;
    }
    case 'update': {
      const { updated } = update({ home, sourceDir });
      for (const u of updated) {
        console.log(`${u.harness}: ${u.from.version} (catalog ${u.from.catalogVersion}) -> ${u.to.version} (catalog ${u.to.catalogVersion})`);
      }
      console.log('Run "refresh" in each project to re-assess it against the new catalog.');
      break;
    }
    case 'init': {
      const root = projectRoot();
      const r = initProject(root, { now: new Date(), local: flag('local'), appendPointers: flag('append-pointers'), workspace: opts.workspace, skillDir: sourceDir });
      if (flag('json')) console.log(JSON.stringify(r, null, 2));
      else if (opts.workspace === null) console.log(summarize('Initialized .ai: ', r));
      else {
        console.log(summarize('Hub .ai: ', r.hub));
        if (r.proposed) {
          console.log(`Detected sibling repos (nothing written to them yet): ${r.proposed.join(', ')}`);
          console.log(`To confirm and initialize them, run: npx android-architect init --workspace ${r.proposed.join(' ')}`);
        }
        for (const [name, m] of Object.entries(r.members)) console.log(summarize(`Member ${name}: `, m));
      }
      break;
    }
    case 'refresh': {
      const root = projectRoot();
      let r;
      try {
        r = refreshAiDir(root, { now: new Date(), skillDir: sourceDir });
      } catch (e) {
        throw e.code === 'NO_MANIFEST' ? new Error('no .ai/manifest.json in this project: run init first (npx android-architect init)') : e;
      }
      if (flag('json')) console.log(JSON.stringify(r, null, 2));
      else printRefresh(r);
      break;
    }
    case 'uninstall': {
      const { removed } = uninstall({ home, force: flag('force') });
      console.log(removed.length ? removed.map((t) => `Removed ${t}`).join('\n') : 'Nothing to remove');
      break;
    }
    case 'doctor': {
      const d = doctor({ home, root: opts.values.root === undefined ? undefined : path.resolve(opts.values.root) });
      if (flag('json')) console.log(JSON.stringify(d, null, 2));
      else {
        console.log(`node: ${d.node}`);
        for (const h of d.harnesses) {
          console.log(`${h.name}: ${h.installed ? `installed v${h.version} (catalog ${h.catalogVersion})` : h.partial ? 'not installed (partial or foreign directory present, no .installed.json)' : 'not installed'}`);
        }
        console.log(`graphify (optional): ${d.optional.graphify ? 'found' : 'not found'}`);
        if (d.project) printProject(d.project);
      }
      break;
    }
    case 'run': {
      const { main } = await import('../skill/scripts/run.js');
      process.exitCode = await main(opts.rest);
      break;
    }
    case 'version':
      console.log(`android-architect ${pkg.version} (catalog ${loadCatalog().catalogVersion})`);
      break;
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof NoHarnessError ? e.message : `Error: ${e.message}`);
  process.exitCode = 1;
}
