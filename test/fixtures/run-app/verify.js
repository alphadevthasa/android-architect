// Fixture verification command: `node verify.js`. Results come from a switch file inside the git folder
// (.git/verify-mode, untracked by construction): a comma separated list of "pass" / "fail", one entry per call, the last
// entry repeating. Missing file = pass. "fail-twice" is shorthand for "fail,fail,pass". The call counter is .git/verify-count.
import fs from 'node:fs';

const read = (f, d) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return d; } };
let mode = read('.git/verify-mode', 'pass');
if (mode === 'fail-twice') mode = 'fail,fail,pass';
const seq = mode.split(',');
const n = Number(read('.git/verify-count', '0'));
fs.writeFileSync('.git/verify-count', String(n + 1));
const result = seq[Math.min(n, seq.length - 1)];
if (result === 'fail') {
  console.error('FAILURE: fixture verification failed (boom)');
  process.exit(1);
}
console.log('fixture verification passed');
