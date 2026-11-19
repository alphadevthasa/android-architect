#!/usr/bin/env node
// Usage: node ai-status.js [<root>]
// Prints how stale <root>/.ai is. Exit 0 even when stale; exit 2 when there is no manifest.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './lib/catalog.js';
import { aiStatus } from './lib/aidir.js';

function fail(code, message) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

export function main(argv) {
  if (argv.length > 1 || argv[0]?.startsWith('--')) fail(1, 'usage: node ai-status.js [<root>]');
  const root = path.resolve(argv[0] ?? '.');
  let status;
  try {
    status = aiStatus(root, { toolCatalogVersion: loadCatalog().catalogVersion });
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
