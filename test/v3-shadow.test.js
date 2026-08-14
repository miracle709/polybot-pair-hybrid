import test from 'node:test';
import assert from 'node:assert/strict';

import { LegBook, MarketBook } from '../src/book.js';
import { GUARDS, PARAMS } from '../src/config.js';
import { PairCompletionTracker } from '../src/pairCompletionTracker.js';
import { RoundRunner } from '../src/roundRunner.js';
import { rungKey } from '../src/util.js';

class SpyExchange {
  constructor() {
    this.mode = 'paper';
    this.placements = [];
    this.sequence = 0;
  }
  async placeLimitBuy(order) {
    this.placements.push({ ...order });
    return { orderId: `order-${++this.sequence}` };
  }
  async cancelOrders() {}
  async cancelEverything() {}
}

function booksAt(timeSeconds) {
  const levels = (bid) => new LegBook(
    [{ price: bid, size: 400 }, { price: bid - 0.01, size: 400 }],
    [{ price: bid + 0.01, size: 400 }, { price: bid + 0.02, size: 400 }],
    timeSeconds
  );
  return new MarketBook(levels(0.49), levels(0.5));
}

test('V3 shadow produces decisions while V2 exchange output remains byte-equivalent', async () => {
  const windowStart = 1_800_000_000;
  const roundSlug = `btc-updown-5m-${windowStart}`;
  const v2Exchange = new SpyExchange();
  const v3Exchange = new SpyExchange();
  const events = [];
  const baseParams = { ...PARAMS, MIN_REQUOTE_INTERVAL_MS: 0 };
  const v2 = new RoundRunner({
    roundSlug,
    windowStartEpoch: windowStart,
    tokenIds: { UP: 'up', DOWN: 'down' },
    exchange: v2Exchange,
    params: { ...baseParams, V3_ENABLED: false },
    guards: structuredClone(GUARDS),
  });
  const v3 = new RoundRunner({
    roundSlug,
    windowStartEpoch: windowStart,
    tokenIds: { UP: 'up', DOWN: 'down' },
    exchange: v3Exchange,
    params: { ...baseParams, V3_ENABLED: true, V3_SHADOW_ONLY: true },
    guards: structuredClone(GUARDS),
    recorder: { record: (event) => events.push(event) },
  });
  v3.setPriceToBeat({
    ptb: 100,
    src: 'chainlink_data_streams',
    publisherTimeMs: windowStart * 1000,
    arrivalTimeMs: windowStart * 1000,
  });

  for (let second = 0; second <= 31; second += 1) {
    const timeSeconds = windowStart + second;
    const timeMs = timeSeconds * 1000;
    const price = 100 + second / 10_000;
    v3.observeBtcReference({
      price,
      source: 'binance_spot',
      publisherTimeMs: timeMs,
      arrivalTimeMs: timeMs,
    });
    v3.observeSettlementReference({
      price,
      source: 'chainlink_data_streams',
      publisherTimeMs: timeMs,
      arrivalTimeMs: timeMs,
    });
    await v2.onBook(booksAt(timeSeconds), timeSeconds, timeMs);
    await v3.onBook(booksAt(timeSeconds), timeSeconds, timeMs);
  }

  assert.deepEqual(v3Exchange.placements, v2Exchange.placements);
  assert.ok(events.some((event) => event.type === 'signal_snapshot'));
  assert.ok(events.some((event) => event.type === 'probability_prediction'));
  assert.ok(events.some((event) => event.type === 'action_candidates'));
  assert.ok(events.some((event) => event.type === 'v3_shadow_decision'));
  assert.equal(v3.v3Status().execution, 'V2_ONLY');
  assert.equal(v3.v3Status().probability.calibrated, false);
  assert.ok(!v3Exchange.placements.some((order) => order.strategyIntent === 'DIRECTIONAL'));
});

test('pair completion telemetry records first fill, causal path, horizons, and final outcome', () => {
  const events = [];
  const tracker = new PairCompletionTracker({
    roundSlug: 'hazard',
    onObservation: (event) => events.push(event),
  });
  tracker.start({
    lot: { id: 'up-1', leg: 'UP', priceMils: 480, ts: 100 },
    shares: 5,
    roundSecond: 10,
  });
  tracker.observeBook({ books: booksAt(112), roundSecond: 12 });
  tracker.complete({
    complementLeg: 'DOWN',
    shares: 5,
    priceMils: 500,
    roundSecond: 14,
  });
  tracker.settle('UP', 300);
  const completed = events.find((event) => event.status === 'COMPLEMENT_FILLED');
  assert.equal(completed.timeToComplementSeconds, 4);
  assert.equal(completed.pairMils, 980);
  assert.equal(completed.completionByHorizon['5'], true);
  assert.ok(events.some((event) => event.status === 'SETTLED' && event.finalOutcome === 'UP'));
});

test('order provenance flows through the ledger into immutable physical fill lots', async () => {
  const exchange = new SpyExchange();
  const runner = new RoundRunner({
    roundSlug: 'provenance-round',
    windowStartEpoch: 0,
    tokenIds: { UP: 'up', DOWN: 'down' },
    exchange,
    params: { ...PARAMS, V3_ENABLED: false, MIN_REQUOTE_INTERVAL_MS: 0 },
    guards: structuredClone(GUARDS),
  });
  await runner.orders.reconcile([{
    key: rungKey('UP', 490),
    leg: 'UP',
    mils: 490,
    shares: 5,
    offsetTicks: 1,
    strategyIntent: 'DIRECTIONAL',
    actionCandidateId: 'candidate-1',
    signalSnapshotId: 'snapshot-1',
    modelVersion: 'model-1',
    expectedEdgeAtDecision: 0.25,
  }], {
    roundSlug: 'provenance-round',
    tokenIds: { UP: 'up', DOWN: 'down' },
  }, 1000);
  assert.equal(exchange.placements[0].strategyIntent, 'DIRECTIONAL');
  runner.onFill({
    leg: 'UP',
    price: 0.49,
    size: 5,
    ts: 1,
    orderId: 'order-1',
  });
  const lot = runner.inventory.lots[0];
  assert.equal(lot.strategyIntent, 'DIRECTIONAL');
  assert.equal(lot.actionCandidateId, 'candidate-1');
  assert.equal(lot.signalSnapshotId, 'snapshot-1');
  assert.equal(lot.modelVersion, 'model-1');
  assert.equal(lot.expectedEdgeAtDecision, 0.25);
});
