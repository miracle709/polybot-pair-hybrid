import test from 'node:test';
import assert from 'node:assert/strict';
import {
  minimumOrderSharesAtMils,
  minimumOrderSharesForParams,
  orderNotionalMeetsMinimum,
} from '../src/orderConstraints.js';

test('price-dependent order minimum satisfies the $1 Polymarket floor', () => {
  assert.equal(minimumOrderSharesAtMils(100), 10);
  assert.equal(minimumOrderSharesAtMils(120), 9);
  assert.equal(minimumOrderSharesAtMils(150), 7);
  assert.equal(minimumOrderSharesAtMils(200), 5);
  assert.equal(minimumOrderSharesAtMils(490), 5);
});

test('order minimum honors share steps and cannot undercut venue constants', () => {
  assert.equal(
    minimumOrderSharesAtMils(120, { stepShares: 0.5 }),
    8.5
  );
  assert.equal(
    minimumOrderSharesForParams(100, {
      MIN_RUNG_SHARES: 1,
      MIN_ORDER_NOTIONAL_USD: 0.5,
      RUNG_SIZE_STEP_SHARES: 1,
    }),
    10
  );
  assert.equal(orderNotionalMeetsMinimum(9, 100), false);
  assert.equal(orderNotionalMeetsMinimum(10, 100), true);
});
