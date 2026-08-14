import test from 'node:test';
import assert from 'node:assert/strict';
import {
  complementCapForLot,
  completionSlices,
  feeMilsPerShareFromBps,
  isPairCompletionEconomic,
  maximumComplementPrice,
  takerFeeMilsPerShare,
} from '../src/pairEconomics.js';

const lot = (id, priceMils, remainingShares) => ({
  id,
  priceMils,
  remainingShares,
});

test('complement cap obeys target, execution buffer, and fee reserve', () => {
  const up = lot('up-1', 380, 10);
  assert.equal(complementCapForLot(up), 600);
  assert.equal(complementCapForLot(up, { expectedFeeMils: 3 }), 597);
  assert.equal(
    complementCapForLot(up, {
      pairTargetMils: 985,
      executionBufferMils: 5,
      expectedFeeMils: 0,
    }),
    600
  );
});

test('boundary price is accepted and one mil over target is rejected', () => {
  const up = lot('up-1', 380, 10);
  assert.equal(
    isPairCompletionEconomic({ lot: up, oppositeMils: 600 }).accepted,
    true
  );
  assert.equal(
    isPairCompletionEconomic({ lot: up, oppositeMils: 601 }).accepted,
    false
  );
});

test('completion slices consume FIFO and support partial lots', () => {
  const result = completionSlices(
    [lot('cheap', 380, 10), lot('expensive', 450, 5)],
    12
  );
  assert.deepEqual(
    result.slices.map(({ lot: row, shares }) => [row.id, shares]),
    [
      ['cheap', 10],
      ['expensive', 2],
    ]
  );
  assert.equal(result.completionShares, 12);
  assert.equal(result.unmatchedRemainder, 0);
});

test('multi-lot quote uses the strictest cap instead of average subsidy', () => {
  const lots = [lot('cheap', 380, 10), lot('expensive', 450, 5)];
  assert.equal(
    maximumComplementPrice({ unmatchedLots: lots, proposedShares: 10 })
      .capMils,
    600
  );
  const spanning = maximumComplementPrice({
    unmatchedLots: lots,
    proposedShares: 12,
  });
  assert.equal(spanning.capMils, 530);
  assert.deepEqual(
    spanning.lotCaps.map(({ lotId, capMils }) => [lotId, capMils]),
    [
      ['cheap', 600],
      ['expensive', 530],
    ]
  );
});

test('excess proposed size is reported rather than treated as paired', () => {
  const result = maximumComplementPrice({
    unmatchedLots: [lot('up', 400, 3)],
    proposedShares: 5,
  });
  assert.equal(result.completionShares, 3);
  assert.equal(result.unmatchedRemainder, 2);
  assert.equal(result.capMils, 580);
});

test('fee helpers round upward and price-dependent taker cap is safe', () => {
  assert.equal(feeMilsPerShareFromBps(500, 10), 1);
  assert.equal(takerFeeMilsPerShare(500, 0.07), 18);
  const up = lot('up', 380, 10);
  const cap = complementCapForLot(up, {
    expectedFeeMils: (priceMils) =>
      takerFeeMilsPerShare(priceMils, 0.07),
  });
  assert.ok(
    380 + cap + 5 + takerFeeMilsPerShare(cap, 0.07) <= 985
  );
  assert.ok(
    380 + (cap + 1) + 5 + takerFeeMilsPerShare(cap + 1, 0.07) > 985
  );
});

test('hard max remains authoritative even with a permissive target', () => {
  const result = isPairCompletionEconomic({
    lot: lot('up', 600, 1),
    oppositeMils: 400,
    pairTargetMils: 1010,
    executionBufferMils: 0,
    hardMaxMils: 995,
  });
  assert.equal(result.capMils, 410);
  assert.equal(result.accepted, false);
  assert.equal(
    isPairCompletionEconomic({
      lot: lot('up', 600, 1),
      oppositeMils: 400,
      pairTargetMils: 1010,
      executionBufferMils: 0,
      hardMaxMils: 995,
      allowNegativePairLock: true,
    }).accepted,
    true
  );
});
