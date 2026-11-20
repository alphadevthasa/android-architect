// Runs the verification commands of run.config.json. The commands are PR-controlled input: each one is spawned from an
// argv array without a shell, with a minimal environment, no stdin, in its own process group (killed as a group on
// timeout), and its output is kept only as a bounded redacted tail. Verification executes the project's Gradle build
// code; confirmFirstUse (rungit.js) is the consent gate for that.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { redact } from './redact.js';
import { stripUnsafe } from './mdtext.js';

const TAIL_BYTES = 20 * 1024;
const KILL_GRACE_MS = 5000;
const CLOSE_GRACE_MS = 2000;
const ENV_NAMES = ['PATH', 'HOME', 'LANG', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME'];
const SIGNATURE_LINES = 5;
const SIGNATURE_LINE_MAX = 500;

/** The only environment a verification command gets (Gradle needs these); everything else is dropped. */
function childEnv() {
  const env = {};
  for (const k of ENV_NAMES) if (typeof process.env[k] === 'string' && process.env[k] !== '') env[k] = process.env[k];
  env.CI = '1';
  return env;
}

/** Keeps the last TAIL_BYTES bytes of everything fed to it; memory never exceeds TAIL_BYTES plus one chunk (<= 64 KB). */
class Tail {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.truncated = false;
  }

  push(chunk) {
    const all = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    if (all.length > TAIL_BYTES) {
      this.truncated = true;
      this.buf = Buffer.from(all.subarray(all.length - TAIL_BYTES));
    } else this.buf = Buffer.from(all);
  }

  /** Text of the tail with the cut start dropped (a half line or half token could hold the end of a secret). */
  text() {
    let b = this.buf;
    let s;
    if (this.truncated) {
      let i = 0;
      while (i < 4 && i < b.length && (b[i] & 0xc0) === 0x80) i++; // split UTF-8 sequence
      b = b.subarray(i);
      s = b.toString('utf8');
      const nl = s.indexOf('\n');
      s = nl >= 0 ? s.slice(nl + 1) : s.slice(128);
    } else s = b.toString('utf8');
    return s;
  }
}

/** Escape sequences, control and bidi characters removed (newline and tab kept), then secrets redacted. */
function cleanTail(raw) {
  const noEsc = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b[\]P^_][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '');
  const noCtl = stripUnsafe(noEsc).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  return redact(noCtl).text;
}

// Normalization for the error signature. Every pattern is linear on a line capped at SIGNATURE_LINE_MAX characters.
const NORMALIZERS = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>'],
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<uuid>'],
  [/(?<![\w.])(?:[A-Za-z]:)?[\\/](?:[^\s\\/:'"()<>[\],;=]+[\\/])+/g, '<dir>/'],
  [/\b0[xX][0-9a-fA-F]+\b/g, '<hex>'],
  [/\b[0-9a-fA-F]{8,}\b/g, '<hex>'],
  [/\d+/g, 'N'],
];

function normalizeLine(line) {
  let out = line.slice(0, SIGNATURE_LINE_MAX);
  for (const [re, to] of NORMALIZERS) out = out.replace(re, to);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Error signature of a failed command (spec 5.15 "normalized error hash"): the first 5 lines containing error, FAILED or
 * Exception (case-insensitive), absolute paths, numbers, hex ids, timestamps and temp dirs normalized, joined and
 * SHA-256'd (first 16 hex chars). A failure without such a line uses its last non-empty line and how it ended.
 */
function signatureOf(tail, ended) {
  const lines = tail.split('\n');
  const hits = [];
  for (const line of lines) {
    const low = line.toLowerCase();
    if (low.includes('error') || low.includes('failed') || low.includes('exception')) {
      hits.push(normalizeLine(line));
      if (hits.length === SIGNATURE_LINES) break;
    }
  }
  if (hits.length === 0) {
    const last = [...lines].reverse().find((l) => l.trim() !== '') ?? '';
    hits.push(`[${ended}]`, normalizeLine(last));
  }
  return crypto.createHash('sha256').update(hits.join('\n')).digest('hex').slice(0, 16);
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

function runOne(root, argv, timeoutMs) {
  return new Promise((resolve) => {
    const tail = new Tail();
    let timedOut = false;
    let settled = false;
    let child;
    const finish = (exitCode, signal, note) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(termTimer);
      clearTimeout(closeTimer);
      const shown = note ? `${note}\n` : '';
      const text = cleanTail(shown + tail.text());
      const ended = timedOut ? 'timeout' : signal ? `signal ${signal}` : `exit ${exitCode}`;
      resolve({
        argv: argv.map((a) => redact(String(a)).text),
        exitCode,
        signal: signal ?? null,
        timedOut,
        tail: text.slice(-TAIL_BYTES),
        signature: exitCode === 0 && !timedOut ? '' : signatureOf(text, ended),
      });
    };
    let killTimer = null;
    let termTimer = null;
    let closeTimer = null;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: root, shell: false, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch {
      finish(null, null, 'the command could not be started');
      return;
    }
    child.on('error', () => finish(null, null, 'the command could not be started'));
    child.stdout.on('data', (c) => tail.push(c));
    child.stderr.on('data', (c) => tail.push(c));
    child.on('exit', (code, signal) => {
      if (timedOut) killGroup(child.pid, 'SIGKILL'); // stragglers that ignored SIGTERM
      // A grandchild may keep the pipes open: do not wait for 'close' forever.
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, CLOSE_GRACE_MS);
      child.once('close', () => finish(code, signal));
    });
    termTimer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
  });
}

/**
 * Runs config.verification.commands one after the other in `root`; the first failure stops the list.
 * Returns { ok, results: [{ argv, exitCode, signal, timedOut, tail, signature }] }. `timeoutMs` is per command
 * (default config.verification.timeoutSeconds). An empty command list is ok with no results (the caller decides
 * whether verifying nothing is acceptable).
 */
export async function runVerification(root, config, { timeoutMs } = {}) {
  const limit = timeoutMs ?? (config?.verification?.timeoutSeconds ?? 1800) * 1000;
  const results = [];
  for (const argv of config?.verification?.commands ?? []) {
    const r = await runOne(root, argv, limit);
    results.push(r);
    if (r.exitCode !== 0 || r.timedOut) return { ok: false, results };
  }
  return { ok: true, results };
}
