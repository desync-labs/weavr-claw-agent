import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPartialExit, formatShares, MIN_PARTIAL_SHARES, parseSpokenShares, sizeUsdWithdraw } from '../tools/lib/shares.mjs';

test('spoken 4 becomes 4 shares in base units; already-converted values are left alone', () => {
  assert.deepEqual(parseSpokenShares('4'), { kind: 'base', sharesBase: '4000000' });
  assert.deepEqual(parseSpokenShares('4.99'), { kind: 'base', sharesBase: '4990000' });
  assert.deepEqual(parseSpokenShares('4000000'), { kind: 'base', sharesBase: '4000000' });
  assert.deepEqual(parseSpokenShares('all'), { kind: 'all' });
  assert.deepEqual(parseSpokenShares('ALL'), { kind: 'all' });
});

test('spoken share parse refuses zero, junk, and too many decimals', () => {
  for (const bad of ['', '0', '0.0', '-1', 'foo', '1.5000001']) {
    assert.throws(() => parseSpokenShares(bad), /shares|withdraw|amount/);
  }
});

test('a partial exit below 0.001, or one that leaves dust, is refused; a full exit is not', () => {
  const held = 4_990_000n;
  assert.equal(assertPartialExit(held, 4_000_000n).ok, true);
  assert.equal(assertPartialExit(held, held).ok, true);
  assert.equal(assertPartialExit(held, 4n).error, 'DUST');
  assert.equal(assertPartialExit(held, held - 500n).error, 'DUST');
  assert.equal(assertPartialExit(held, held + 1n).error, 'INSUFFICIENT_SHARES');
  assert.equal(MIN_PARTIAL_SHARES, 1000n);
  assert.equal(formatShares(4_990_000n), '4.99');
});

test('a dollar withdrawal converts at the live price and snaps leftover dust to a full exit', () => {
  const held = 4_990_000n;
  const atPar = sizeUsdWithdraw('4', { held, price: 1_000_000n });
  assert.equal(atPar.ok, true);
  assert.equal(atPar.fullExit, false);
  assert.equal(atPar.sharesBase, '4000000');
  assert.equal(atPar.amountUsd, 4);

  const allOfIt = sizeUsdWithdraw('5', { held, price: 1_000_000n });
  assert.equal(allOfIt.fullExit, true);
  assert.equal(allOfIt.sharesBase, '4990000');

  const snap = sizeUsdWithdraw('4.9896', { held, price: 1_000_000n });
  assert.equal(snap.fullExit, true);
  assert.equal(snap.snapped, true);
  assert.equal(snap.sharesBase, '4990000');

  const dust = sizeUsdWithdraw('0.0001', { held, price: 1_000_000n });
  assert.equal(dust.ok, false);
  assert.equal(dust.error, 'BELOW_MINIMUM');
  assert.match(dust.detail, /\$0\.001/);
  assert.equal(dust.minUsd, 0.001);
});
