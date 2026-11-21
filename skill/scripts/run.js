#!/usr/bin/env node
// Entry of the autonomous run loop: `node run.js [flags]` (flags: see lib/runcli.js USAGE, or --help).
// This file imports NO project library statically: it first checks that it is not a copy under `.ai/tools` (generated,
// and changeable by anyone who can change the repository), and only then loads the implementation, so a refused copy
// executes none of its sibling libraries. The check is advisory against a hand-edited copy (that copy can simply skip
// it); the real controls are that the run loop is never vendored into `.ai/tools` and that `refresh` removes stale copies.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const VENDORED_MESSAGE = 'this copy of run.js lives under .ai/tools, which is generated and can be changed by anyone who can change the repository, so it will not run: use `npx android-architect run` or the run.js of the installed skill';

function underVendored(file) {
  const parts = String(file).split(/[\\/]/);
  for (let i = 0; i + 1 < parts.length; i++) if (parts[i] === '.ai' && parts[i + 1] === 'tools') return true;
  return false;
}

/** Resolves to the exit code (the caller sets process.exitCode). `io` is the test seam of lib/runcli.js. */
export async function main(argv, io = {}) {
  const self = fileURLToPath(import.meta.url);
  let real = self;
  try {
    real = fs.realpathSync(self);
  } catch {
    // keep the plain path
  }
  if (underVendored(self) || underVendored(real)) {
    const out = io.stdout ?? process.stdout;
    const err = io.stderr ?? process.stderr;
    err.write(`${VENDORED_MESSAGE}\n`);
    if (argv.includes('--json')) out.write(`${JSON.stringify({ outcome: 'refused', reason: VENDORED_MESSAGE, exitCode: 2 })}\n`);
    return 2;
  }
  const impl = await import('./lib/runcli.js');
  return impl.main(argv, io);
}

const isMain = () => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (process.argv[1] && isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
