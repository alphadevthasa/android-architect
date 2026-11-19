#!/usr/bin/env node
// Usage: node ai-status.js [<root>] [--trust-modified-tools]
// Prints how stale <root>/.ai is. Exit 0 even when stale; exit 2 when there is no manifest.
// Run from the installed skill, it verifies .ai/tools against that skill. Run from a vendored .ai/tools/scripts copy, it
// only checks .ai/tools against .ai/manifest.json (weaker) and exits 3 when they differ, unless --trust-modified-tools.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './lib/catalog.js';
import { aiStatus } from './lib/aidir.js';
import { TRUST_FLAG, MODIFIED_MESSAGE, vendoredAiDir, vendoredToolsRefused } from './lib/integrity.js';

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

export function main(argv) {
  if (vendoredToolsRefused(import.meta.url, argv)) fail(3, MODIFIED_MESSAGE);
  const args = argv.filter((a) => a !== TRUST_FLAG);
  if (args.length > 1 || args[0]?.startsWith('--')) fail(1, `usage: node ai-status.js [<root>] [${TRUST_FLAG}]`);
  const root = path.resolve(args[0] ?? '.');
  let status;
  try {
    status = aiStatus(root, { toolCatalogVersion: loadCatalog().catalogVersion, selfCheck: vendoredAiDir(import.meta.url) !== null });
  } catch (e) {
    fail(1, e.message);
  }
  if (status.manifest === null) fail(2, `no .ai/manifest.json in ${root}; run init-ai.js first`);
  process.stdout.write(JSON.stringify(status, null, 2) + '\n');
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
