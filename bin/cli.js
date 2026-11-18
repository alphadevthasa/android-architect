#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { install, uninstall, doctor, NoHarnessError } from '../skill/scripts/lib/install.js';
import { loadCatalog } from '../skill/scripts/lib/catalog.js';

const USAGE = `Usage: android-architect <install|uninstall|doctor|version> [--claude] [--codex] [--force] [--home <dir>] [--json]`;
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const sourceDir = fileURLToPath(new URL('../skill', import.meta.url));

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(`--${n}`);
const hi = args.indexOf('--home');
const homeArg = hi >= 0 ? args[hi + 1] : undefined;
const badHome = hi >= 0 && (!homeArg || homeArg.startsWith('--'));
if (badHome) {
  console.error(`--home needs a directory value\n${USAGE}`);
  process.exit(1);
}
const home = hi >= 0 ? homeArg : os.homedir();

try {
  switch (cmd) {
    case 'install': {
      const { installed } = install({ home, claude: flag('claude'), codex: flag('codex'), force: flag('force'), sourceDir });
      for (const t of installed) console.log(`Installed to ${t}`);
      break;
    }
    case 'uninstall': {
      const { removed } = uninstall({ home, force: flag('force') });
      console.log(removed.length ? removed.map((t) => `Removed ${t}`).join('\n') : 'Nothing to remove');
      break;
    }
    case 'doctor': {
      const d = doctor({ home });
      if (flag('json')) console.log(JSON.stringify(d, null, 2));
      else {
        console.log(`node: ${d.node}`);
        for (const h of d.harnesses) {
          console.log(`${h.name}: ${h.installed ? `installed v${h.version} (catalog ${h.catalogVersion})` : h.partial ? 'not installed (partial or foreign directory present, no .installed.json)' : 'not installed'}`);
        }
        console.log(`graphify (optional): ${d.optional.graphify ? 'found' : 'not found'}`);
      }
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
