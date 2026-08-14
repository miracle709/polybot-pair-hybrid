import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateBuyDown,
  evaluateBuyUp,
  evaluatePair,
  portfolioAfterBuy,
  portfolioPayoff,
} from '../src/portfolioMath.js';
import {
  ActionType,
  createActionCandidate,
  noActionCandidate,
} from '../src/actions/actionCandidate.js';
import { StrategyIntent } from '../src/strategyIntent.js';
import { ExecutionType, executionFeeUsd } from '../src/fees.js';

test('UP action payoff and simplified expectation are identical', () => {
  const result = evaluateBuyUp({
    shares: 10,
    price: 0.42,
    feeUsd: 0.03,
    probabilityUp: 0.61,
  });
  assert.equal(result.deltaIfUp, 5.77);
  assert.equal(result.deltaIfDown, -4.23);
  assert.equal(result.expectedPnlDelta, 1.87);
  assert.ok(
    Math.abs(
      result.expectedPnlDelta -
        (0.61 * result.deltaIfUp + 0.39 * result.deltaIfDown)
    ) < 1e-9
  );
});

test('DOWN action payoff and simplified expectation are identical', () => {
  const result = evaluateBuyDown({
    shares: 8,
    price: 0.31,
    feeUsd: 0.02,
    probabilityUp: 0.4,
  });
  assert.equal(result.deltaIfUp, -2.5);
  assert.equal(result.deltaIfDown, 5.5);
  assert.equal(result.expectedPnlDelta, 2.3);
  assert.ok(
    Math.abs(
      result.expectedPnlDelta -
        (0.4 * result.deltaIfUp + 0.6 * result.deltaIfDown)
    ) < 1e-9
  );
});

test('pair payoff is deterministic and includes execution costs once', () => {
  const result = evaluatePair({
    shares: 5,
    upPrice: 0.47,
    downPrice: 0.49,
    executionCostsUsd: 0.01,
  });
  assert.equal(result.pairDelta, 0.19);
  assert.equal(result.deltaIfUp, result.deltaIfDown);
  assert.equal(result.expectedPnlDelta, result.pairDelta);
});

test('portfolio payoff uses exact terminal state and fees exactly once', () => {
  const state = portfolioPayoff({
    qUp: 12,
    qDown: 7,
    costUsd: 8.4,
    feesUsd: 0.1,
  });
  assert.equal(state.pnlIfUp, 3.5);
  assert.equal(state.pnlIfDown, -1.5);
  assert.equal(state.worstCasePnl, -1.5);
  const after = portfolioAfterBuy(state, {
    leg: 'DOWN',
    shares: 2,
    price: 0.4,
    feeUsd: 0.02,
  });
  assert.equal(after.pnlIfUp, 2.68);
  assert.equal(after.pnlIfDown, -0.32);
  assert.equal(after.feesUsd, 0.12);
});

test('action candidates are immutable and NO_ACTION is always eligible', () => {
  const candidate = createActionCandidate({
    type: ActionType.PAIR_OPEN,
    intent: StrategyIntent.PAIR_OPEN,
    eligible: true,
    reasons: ['economic'],
  });
  assert.equal(candidate.intent, StrategyIntent.PAIR_OPEN);
  assert.ok(Object.isFrozen(candidate));
  assert.deepEqual(noActionCandidate(), {
    type: ActionType.NO_ACTION,
    intent: null,
    leg: null,
    shares: 0,
    limitMils: null,
    expectedFillPriceMils: null,
    expectedFeeUsd: 0,
    pnlIfUpAfter: null,
    pnlIfDownAfter: null,
    worstCasePnlAfter: null,
    expectedPnlDelta: 0,
    robustExpectedPnlDelta: 0,
    capitalRequired: 0,
    riskDelta: 0,
    pairInteraction: null,
    signalSnapshotId: null,
    predictedProbability: null,
    probabilityLower: null,
    probabilityUpper: null,
    executionType: null,
    reasons: [],
    eligible: true,
  });
});

test('action-specific fee model separates maker and nonlinear taker fees', () => {
  const maker = executionFeeUsd({
    executionType: ExecutionType.MAKER,
    shares: 10,
    price: 0.5,
    makerBps: 10,
    takerBps: 90,
  });
  const taker = executionFeeUsd({
    executionType: ExecutionType.TAKER,
    shares: 10,
    price: 0.5,
    makerBps: 10,
    takerFeeRate: 0.07,
  });
  assert.equal(maker, 0.005);
  assert.equal(taker, 0.175);
});
