import test from 'node:test';
import assert from 'node:assert/strict';
import { cryptoTakerFeeUsd } from '../src/fees.js';

test('cryptoTakerFeeUsd matches Polymarket curve and rejects maker-edge cases', () => {
  // 10 shares @ 0.48 with rate 0.07 → 10 * 0.07 * 0.48 * 0.52 = 0.17472
  assert.equal(cryptoTakerFeeUsd(10, 0.48, 0.07), 0.17472);
  assert.equal(cryptoTakerFeeUsd(0, 0.48, 0.07), 0);
  assert.equal(cryptoTakerFeeUsd(10, 0, 0.07), 0);
  assert.equal(cryptoTakerFeeUsd(10, 1, 0.07), 0);
  assert.equal(cryptoTakerFeeUsd(10, 0.48, -1), 0);
});
