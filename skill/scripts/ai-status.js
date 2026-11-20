#!/usr/bin/env node
// Usage: node ai-status.js [<root>] [--trust-modified-tools]
// Prints how stale <root>/.ai is. Exit 0 even when stale; exit 2 when there is no manifest.
// Run from the installed skill, it verifies .ai/tools against that skill. Run from a vendored .ai/tools/scripts copy, it
// only checks .ai/tools against .ai/manifest.json (weaker) and exits 3 when they differ, unless --trust-modified-tools.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Only integrity.js (Node builtins, hash.js, manifest.js) is imported statically: a vendored copy checks itself before
// it loads any other module of .ai/tools.
import { TRUST_FLAG, vendoredAiDir, vendoredRefusal } from './lib/integrity.js';

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

export async function main(argv) {
  const refusal = vendoredRefusal(import.meta.url, argv);
  if (refusal) fail(3, refusal);
  const { loadCatalog } = await import('./lib/catalog.js');
  const { aiStatus } = await import('./lib/aidir.js');
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
