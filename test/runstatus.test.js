import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus } from '../skill/scripts/lib/runstatus.js';

const good = { step: 'safety-net:login', status: 'done', summary: 'Added tests', filesChanged: ['app/src/A.kt'], verification: 'gradle passed' };
const block = (o) => `<<<STATUS\n${JSON.stringify(o)}\nSTATUS>>>`;
const STEP = 'safety-net:login';

test('a valid block parses', () => {
  const r = parseStatus(`Some prose\n${block(good)}\nmore`, STEP);
  assert.deepEqual(r, { ok: true, status: good });
  assert.equal(parseStatus(`${block(good).replaceAll('\n', '\r\n')}\r\n`, STEP).ok, true);
});

test('a status forged in prose or with markers inside a line is refused', () => {
  assert.equal(parseStatus(JSON.stringify(good), STEP).ok, false);
  assert.equal(parseStatus(`I will print <<<STATUS ${JSON.stringify(good)} STATUS>>> now`, STEP).ok, false);
  assert.equal(parseStatus(`<<<STATUS${JSON.stringify(good)}STATUS>>>`, STEP).ok, false);
  assert.equal(parseStatus(`  <<<STATUS\n${JSON.stringify(good)}\nSTATUS>>>`, STEP).ok, false);
  assert.equal(parseStatus(`<<<STATUS\n${JSON.stringify(good)}\n`, STEP).ok, false);
  assert.equal(parseStatus(42, STEP).ok, false);
});

test('two blocks: the last wins', () => {
  const r = parseStatus(`${block({ ...good, status: 'failed' })}\ntext\n${block(good)}\n`, STEP);
  assert.equal(r.ok, true);
  assert.equal(r.status.status, 'done');
  const r2 = parseStatus(`${block(good)}\n${block({ ...good, status: 'blocked' })}`, STEP);
  assert.equal(r2.status.status, 'blocked');
});

test('wrong step, extra keys, bad types and limits are refused', () => {
  assert.equal(parseStatus(block({ ...good, step: 'other' }), STEP).ok, false);
  assert.equal(parseStatus(block({ ...good, extra: 1 }), STEP).ok, false);
  assert.equal(parseStatus(block({ ...good, status: 'ok' }), STEP).ok, false);
  assert.equal(parseStatus(block({ ...good, summary: 'x'.repeat(2001) }), STEP).ok, false);
  assert.equal(parseStatus(block({ ...good, summary: 'x'.repeat(2000) }), STEP).ok, true);
  assert.equal(parseStatus(block({ ...good, filesChanged: Array(201).fill('a') }), STEP).ok, false);
  assert.equal(parseStatus(block({ ...good, filesChanged: Array(200).fill('a') }), STEP).ok, true);
  assert.equal(parseStatus(block({ ...good, filesChanged: ['x'.repeat(301)] }), STEP).ok, false);
  assert.equal(parseStatus(block({ ...good, filesChanged: [1] }), STEP).ok, false);
  assert.equal(parseStatus(block({ ...good, filesChanged: 'a' }), STEP).ok, false);
  const { verification, ...missing } = good; // eslint-disable-line no-unused-vars
  assert.equal(parseStatus(block(missing), STEP).ok, false);
  assert.equal(parseStatus('<<<STATUS\n[1]\nSTATUS>>>', STEP).ok, false);
  assert.equal(parseStatus('<<<STATUS\n{nope\nSTATUS>>>', STEP).ok, false);
  assert.equal(parseStatus(block(good), 'other-step').ok, false);
  assert.equal(parseStatus(block({ ...good, step: '__proto__' }), '__proto__').ok, true);
});

test('3 MB of hostile output is scanned in bounded time', () => {
  for (const unit of ['STATUS>>>\n', '<<<STATUS\n', 'STATUS>>>', 'a\n', '\n'.repeat(10)]) {
    const raw = unit.repeat(Math.ceil((3 * 1024 * 1024) / unit.length));
    const t = process.hrtime.bigint();
    assert.equal(parseStatus(raw, STEP).ok, false);
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 1500, `slow for ${JSON.stringify(unit.slice(0, 12))}`);
  }
  const big = 'noise line\n'.repeat(250000) + block(good);
  const t = process.hrtime.bigint();
  assert.equal(parseStatus(big, STEP).ok, true);
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 1500);
});

test('control characters are stripped from summary and verification; bad file paths invalidate the status', () => {
  const r = parseStatus(block({ ...good, summary: 'a\u0000b\u001b[31mc\u202ed\nline2', verification: 'x\u0007y' }), STEP);
  assert.equal(r.ok, true);
  assert.equal(r.status.summary, 'ab[31mc d\nline2');
  assert.equal(r.status.verification, 'xy');
  for (const f of ['/etc/passwd', '../x', 'a/../b', 'a\\..\\b', '-rf', 'a\nb', 'a\u0000b', '', 'C:\\x', '\\\\host\\x']) {
    assert.equal(parseStatus(block({ ...good, filesChanged: [f] }), STEP).ok, false, JSON.stringify(f));
  }
  assert.equal(parseStatus(block({ ...good, filesChanged: ['a..b/c.kt', 'a:b'] }), STEP).ok, true);
});
