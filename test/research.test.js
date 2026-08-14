import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDecisionDataset } from '../research/dataset.js';
import { walkForwardEvaluate } from '../research/walkForward.js';

test('dataset builder rejects a feature snapshot containing look-ahead timestamps', () => {
  const events = [
    {
      type: 'signal_snapshot',
      snapshot: {
        snapshotId: 'future',
        roundId: 'r1',
        decisionTimeMs: 1000,
        sourceTimestamps: { btcPublisherTimeMs: 1001 },
      },
    },
    { type: 'ROUND_RESULT', rid: 'r1', winner: 'UP' },
  ];
  const dataset = buildDecisionDataset(events);
  assert.equal(dataset.rows.length, 0);
  assert.deepEqual(dataset.rejected, [
    { snapshotId: 'future', reason: 'look_ahead_timestamp' },
  ]);
});

test('walk-forward evaluation trains only on past rounds and emits required metrics', () => {
  const rows = [];
  for (let index = 0; index < 8; index += 1) {
    rows.push({
      roundId: `r${index}`,
      decisionTimestampMs: index * 1000,
      marketMidpoint: 0.5,
      eventualWinner: index % 2 === 0 ? 'UP' : 'DOWN',
      features: {
        rawGapBps: index % 2 === 0 ? 2 : -2,
        upBestAsk: 0.51,
        downBestAsk: 0.51,
        settlementReferencePrice: index % 2 === 0 ? 101 : 99,
        priceToBeat: 100,
        realizedVolatility: 0.001,
        timeRemainingSeconds: 100,
      },
    });
  }
  const report = walkForwardEvaluate(rows, {
    featureNames: ['rawGapBps'],
    minimumTrainRounds: 3,
    validationRounds: 1,
  });
  assert.equal(report.chronological, true);
  assert.equal(report.folds.length, 5);
  assert.equal(report.folds[0].trainThroughRound, 'r2');
  assert.deepEqual(report.folds[0].validationRounds, ['r3']);
  assert.equal(report.learned.sampleCount, 5);
  assert.ok(Number.isFinite(report.learned.brierScore));
  assert.ok(Number.isFinite(report.learned.logLoss));
  assert.ok(Number.isFinite(report.learned.calibrationError));
  assert.ok(Number.isFinite(report.learned.maxDrawdownUsdPerShare));
  assert.equal(report.baselines.noAction.netDirectionalPnlUsdPerShare, 0);
  assert.equal(report.artifact.validation.method, 'wilson_walk_forward');
});

