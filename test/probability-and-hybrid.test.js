import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzePairInteraction } from '../src/actions/pairInteraction.js';
import { ActionType } from '../src/actions/actionCandidate.js';
import { GUARDS, PARAMS } from '../src/config.js';
import { executionFeeUsd, ExecutionType } from '../src/fees.js';
import { HybridController } from '../src/hybridController.js';
import { RoundInventory } from '../src/inventory.js';
import { MarketResidualLogisticModel } from '../src/models/marketResidualLogisticModel.js';
import {
  EmpiricalExecutionReserveModel,
  StaticExecutionReserveModel,
} from '../src/models/executionReserveModel.js';
import { probabilityPrediction } from '../src/models/probabilityModel.js';
import { StructuralProbabilityModel } from '../src/models/structuralModel.js';
import { portfolioAfterBuy, portfolioPayoff } from '../src/portfolioMath.js';
import { SourceQuality } from '../src/signals/sourceQuality.js';

const validSnapshot = (overrides = {}) => Object.freeze({
  snapshotId: 'snap',
  valid: true,
  invalidReasons: Object.freeze([]),
  roundSecond: 100,
  timeRemainingSeconds: 200,
  priceToBeat: 100,
  settlementReferencePrice: 100.1,
  realizedVolatility: 0.0001,
  upMid: 0.405,
  downMid: 0.595,
  upBestBid: 0.4,
  upBestAsk: 0.41,
  downBestBid: 0.59,
  downBestAsk: 0.6,
  priceToBeatSourceQuality: SourceQuality.AUTHORITATIVE,
  settlementReferenceSourceQuality: SourceQuality.AUTHORITATIVE,
  depthFeatures: Object.freeze({ upAsk: 100, downAsk: 100 }),
  ...overrides,
});

const calibrated = (overrides = {}) => probabilityPrediction({
  pUp: 0.7,
  lower: 0.68,
  upper: 0.72,
  modelVersion: 'calibrated-test',
  calibrated: true,
  valid: true,
  ...overrides,
});

const params = (overrides = {}) => ({
  ...PARAMS,
  V3_ENABLED: true,
  V3_SHADOW_ONLY: true,
  V3_MAKER_FEE_BPS: 0,
  V3_BUILDER_FEE_BPS: 0,
  MAX_DIRECTIONAL_LOSS_USD: 5,
  MAX_DIRECTIONAL_SHARES: 10,
  ...overrides,
});

test('structural model handles terminal and zero-volatility cases without claiming calibration', () => {
  const model = new StructuralProbabilityModel();
  const tied = model.predict(validSnapshot({
    settlementReferencePrice: 100,
    priceToBeat: 100,
    realizedVolatility: 0,
  }));
  assert.equal(tied.pUp, 0.5);
  assert.equal(tied.lower, 0);
  assert.equal(tied.upper, 1);
  assert.equal(tied.calibrated, false);
  assert.equal(tied.valid, true);
  const above = model.predict(validSnapshot({
    settlementReferencePrice: 101,
    priceToBeat: 100,
    realizedVolatility: 0,
  }));
  assert.equal(above.pUp, 1);
});

test('market residual model uses midpoint logit and only accepts empirical calibration metadata', () => {
  const model = new MarketResidualLogisticModel({
    minimumCalibrationSamples: 500,
    artifact: {
      modelVersion: 'residual-test',
      featureNames: ['rawGapBps'],
      coefficients: { rawGapBps: 0.1 },
      featureMeans: { rawGapBps: 0 },
      featureScales: { rawGapBps: 1 },
      validation: {
        calibrated: true,
        method: 'wilson_walk_forward',
        sampleCount: 600,
        uncertaintyBins: [
          { minP: 0, maxP: 1, lower: 0.3, upper: 0.6, sampleCount: 600 },
        ],
      },
    },
  });
  const prediction = model.predict(validSnapshot({ rawGapBps: 1 }));
  assert.equal(prediction.valid, true);
  assert.equal(prediction.calibrated, true);
  assert.ok(prediction.pUp >= prediction.lower && prediction.pUp <= prediction.upper);

  const boundary = model.predict(validSnapshot({ upMid: 1, rawGapBps: 1 }));
  assert.equal(boundary.valid, true);
  const invalid = model.predict(validSnapshot({ upMid: 2, rawGapBps: 1 }));
  assert.equal(invalid.valid, false);
});

test('invalid probability interval is rejected', () => {
  const output = probabilityPrediction({
    pUp: 0.7,
    lower: 0.8,
    upper: 0.9,
    modelVersion: 'bad',
    calibrated: true,
    valid: true,
  });
  assert.equal(output.valid, false);
  assert.ok(output.reasons.includes('invalid_probability_interval'));
  const outOfRange = probabilityPrediction({
    pUp: 1.2,
    lower: 0.8,
    upper: 1,
    modelVersion: 'bad-range',
    calibrated: true,
    valid: true,
  });
  assert.equal(outOfRange.valid, false);
  assert.ok(outOfRange.reasons.includes('probability_out_of_range'));
});

test('canonical fee model handles maker, nonlinear taker, builder, zero, and invalid price', () => {
  assert.equal(executionFeeUsd({
    executionType: ExecutionType.MAKER,
    shares: 10,
    price: 0.5,
    makerBps: 10,
    builderFeeBps: 20,
  }), 0.015);
  assert.equal(executionFeeUsd({
    executionType: ExecutionType.TAKER,
    shares: 10,
    price: 0.5,
    takerFeeRate: 0.07,
    builderFeeBps: 20,
  }), 0.185);
  assert.equal(executionFeeUsd({
    executionType: ExecutionType.MAKER,
    shares: 10,
    price: 0.5,
    makerBps: 0,
    builderFeeBps: 0,
  }), 0);
  assert.throws(() => executionFeeUsd({
    executionType: ExecutionType.MAKER,
    shares: 10,
    price: 1,
    makerBps: 0,
  }), /price/);
});

test('empirical execution reserve uses validated markout quantiles and otherwise falls back', () => {
  const fallback = new StaticExecutionReserveModel({ makerBps: 10, takerBps: 25 });
  const state = {
    executionType: 'MAKER',
    shares: 10,
    price: 0.5,
    snapshot: {
      roundSecond: 100,
      remainingVolatilityEstimate: 5,
      spread: { upMils: 10 },
      depthFeatures: { upBid: 150 },
      rawGapBps: 2,
    },
  };
  assert.equal(fallback.reserveUsd(state), 0.005);
  const empirical = new EmpiricalExecutionReserveModel({
    fallback,
    artifact: {
      validation: { walkForward: true, noLookAhead: true, quantile: 0.95 },
      buckets: {
        'MAKER:normal:low:tight:deep:up': {
          sampleCount: 500,
          adverseMoveMilsPerShare: 3,
        },
      },
    },
  });
  assert.equal(empirical.reserveUsd(state), 0.03);
  const unvalidated = new EmpiricalExecutionReserveModel({ artifact: {}, fallback });
  assert.equal(unvalidated.reserveUsd(state), 0.005);
});

test('historical and marginal fees are each counted exactly once', () => {
  const before = portfolioPayoff({ qUp: 5, qDown: 5, costUsd: 4, feesUsd: 0.1 });
  const after = portfolioAfterBuy(before, {
    leg: 'UP',
    shares: 1,
    price: 0.4,
    feeUsd: 0.02,
  });
  assert.equal(after.feesUsd, 0.12);
  assert.equal(after.pnlIfUp, 1.48);
  assert.equal(after.pnlIfDown, 0.48);
});

test('portfolio marginal EV algebra holds over a deterministic property grid', async () => {
  const { evaluateBuyDown, evaluateBuyUp } = await import('../src/portfolioMath.js');
  for (const q of [0.1, 1, 5, 10.25]) {
    for (const p of [0.01, 0.2, 0.5, 0.99]) {
      for (const pi of [0, 0.2, 0.7, 1]) {
        const fee = 0.001;
        const up = evaluateBuyUp({ shares: q, price: p, feeUsd: fee, probabilityUp: pi });
        const down = evaluateBuyDown({ shares: q, price: p, feeUsd: fee, probabilityUp: pi });
        assert.ok(Math.abs(up.expectedPnlDelta - (pi * up.deltaIfUp + (1 - pi) * up.deltaIfDown)) < 1e-6);
        assert.ok(Math.abs(down.expectedPnlDelta - (pi * down.deltaIfUp + (1 - pi) * down.deltaIfDown)) < 1e-6);
      }
    }
  }
});

test('FIFO pair interaction catches a directional bad complete set regardless of intent', () => {
  const inventory = new RoundInventory('pair-check', 0);
  inventory.addFill('DOWN', 650, 5, 1, { intent: 'DIRECTIONAL' });
  const interaction = analyzePairInteraction({
    inventory,
    leg: 'UP',
    shares: 5,
    priceMils: 400,
    pairHardMaxMils: 995,
  });
  assert.equal(interaction.sharesCompleting, 5);
  assert.equal(interaction.worstPairMils, 1050);
  assert.equal(interaction.eligible, false);
});

test('calibrated robust edge selects a legal directional size within loss and share budgets', () => {
  const controller = new HybridController({ params: params(), guards: structuredClone(GUARDS) });
  const inventory = new RoundInventory('direction', 0);
  const decision = controller.decide({
    inventory,
    signalSnapshot: validSnapshot(),
    probability: calibrated(),
    pairRegime: 'ACCUMULATION',
    v2Decision: { rungs: [] },
  });
  assert.equal(decision.selected.type, ActionType.DIRECTIONAL_UP_MAKER);
  assert.equal(decision.selected.shares, 10);
  assert.ok(decision.selected.robustExpectedPnlDelta > 0);
  assert.ok(decision.selected.worstCasePnlAfter >= -5);
  assert.equal(decision.selected.pairInteraction.sharesCompleting, 0);
});

test('uncalibrated or invalid model output cannot authorize directional capital', () => {
  const controller = new HybridController({ params: params(), guards: structuredClone(GUARDS) });
  const inventory = new RoundInventory('no-capital', 0);
  const prediction = new StructuralProbabilityModel().predict(validSnapshot());
  const decision = controller.decide({
    inventory,
    signalSnapshot: validSnapshot(),
    probability: prediction,
    pairRegime: 'ACCUMULATION',
    v2Decision: { rungs: [] },
  });
  assert.equal(decision.selected.type, ActionType.NO_ACTION);
  assert.ok(decision.rejected.some((candidate) => candidate.reasons.includes('model_uncalibrated')));
});

test('directional candidates respect worst-case loss and physical pair hard max', () => {
  const controller = new HybridController({
    params: params({ MAX_DIRECTIONAL_LOSS_USD: 1 }),
    guards: structuredClone(GUARDS),
  });
  const empty = controller.decide({
    inventory: new RoundInventory('loss', 0),
    signalSnapshot: validSnapshot(),
    probability: calibrated(),
    pairRegime: 'ACCUMULATION',
    v2Decision: { rungs: [] },
  });
  assert.equal(empty.selected.type, ActionType.NO_ACTION);
  assert.ok(empty.rejected.some((candidate) => candidate.reasons.includes('max_directional_loss')));

  const inventory = new RoundInventory('pair-hard', 0);
  inventory.addFill('DOWN', 650, 5, 1);
  const blocked = new HybridController({
    params: params(),
    guards: structuredClone(GUARDS),
  }).decide({
    inventory,
    signalSnapshot: validSnapshot(),
    probability: calibrated(),
    pairRegime: 'ACCUMULATION',
    v2Decision: { rungs: [] },
  });
  assert.equal(blocked.selected.type, ActionType.NO_ACTION);
  assert.ok(blocked.rejected.some((candidate) =>
    candidate.leg === 'UP' && candidate.reasons.includes('pair_hard_max')
  ));
});

test('V2-economic pair completion retains rollout priority over directional value', () => {
  const inventory = new RoundInventory('priority', 0);
  inventory.addFill('UP', 300, 5, 1);
  const controller = new HybridController({ params: params(), guards: structuredClone(GUARDS) });
  const decision = controller.decide({
    inventory,
    signalSnapshot: validSnapshot(),
    probability: calibrated({ pUp: 0.9, lower: 0.85, upper: 0.95 }),
    pairRegime: 'COMPLETION',
    v2Decision: {
      rungs: [{ leg: 'DOWN', mils: 600, shares: 5, opening: false }],
    },
  });
  assert.equal(decision.selected.type, ActionType.PAIR_COMPLETE);
  assert.equal(decision.selected.pairInteraction.worstPairMils, 900);
});
