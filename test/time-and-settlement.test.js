import test from 'node:test';
import assert from 'node:assert/strict';
import { VenueClock, roundTiming } from '../src/live/venueClock.js';
import {
  SettlementLedger,
  easternDateKey,
  normalizeSettlement,
} from '../src/live/settlementLedger.js';
import { Engine } from '../src/engine.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('venue clock advances monotonically from a fresh websocket anchor', () => {
  let wallMs = 1_785_231_666_500;
  let monotonicMs = 10_000;
  const clock = new VenueClock({
    wallNowMs: () => wallMs,
    monotonicNowMs: () => monotonicMs,
    maxSourceSkewMs: 10_000,
  });

  assert.equal(clock.observe(1_785_231_666.161), true);
  assert.equal(clock.nowEpochSeconds(), 1_785_231_666.161);
  monotonicMs += 1_250;
  wallMs += 1_250;
  assert.equal(clock.nowEpochSeconds(), 1_785_231_667.411);
  assert.equal(clock.snapshot().source, 'polymarket_ws');
});

test('stale snapshot time is rejected and system fallback remains usable', () => {
  const wallMs = 1_785_231_666_500;
  const clock = new VenueClock({
    wallNowMs: () => wallMs,
    monotonicNowMs: () => 0,
    maxSourceSkewMs: 120_000,
  });
  assert.equal(clock.observe((wallMs - 25 * 60_000) / 1000), false);
  assert.equal(clock.nowEpochSeconds(), wallMs / 1000);
  assert.equal(clock.snapshot().source, 'system_fallback');
});

test('trusted Gamma server time can bootstrap despite local clock skew', () => {
  const clock = new VenueClock({
    wallNowMs: () => 1_785_231_000_000,
    monotonicNowMs: () => 50,
    maxSourceSkewMs: 5_000,
  });
  assert.equal(
    clock.observe(1_785_231_666, {
      trusted: true,
      source: 'gamma_http',
    }),
    true
  );
  assert.equal(clock.nowEpochSeconds(), 1_785_231_666);
  assert.equal(clock.snapshot().source, 'gamma_http');
});

test('round timing is derived from the active market slug', () => {
  const timing = roundTiming({
    roundSlug: 'btc-updown-5m-1785231600',
    fallbackStart: 123,
    nowEpochSeconds: 1_785_231_666.161,
  });
  assert.equal(timing.startEpoch, 1_785_231_600);
  assert.equal(timing.endEpoch, 1_785_231_900);
  assert.ok(Math.abs(timing.elapsedSeconds - 66.161) < 1e-6);
  assert.ok(Math.abs(timing.remainingSeconds - 233.839) < 1e-6);
});

test('settlement ledger restores totals and replaces duplicates', () => {
  const ledger = new SettlementLedger([
    {
      round_slug: 'btc-updown-5m-1785231000',
      winner: 'UP',
      pnl_usdc: 0.67,
      volume_usdc: 99.33,
      net_shares_up: 100,
      net_shares_down: 100,
      ts: 1_785_231_300,
    },
  ]);
  ledger.upsert({
    roundSlug: 'btc-updown-5m-1785231300',
    winner: 'UP',
    pnlUsd: 146.238,
    costUsd: 553.762,
    ts: 1_785_231_600,
  });
  assert.equal(ledger.totalPnlUsd, 146.908);
  assert.equal(ledger.size, 2);

  ledger.upsert({
    roundSlug: 'btc-updown-5m-1785231300',
    winner: 'UP',
    pnlUsd: 140,
    costUsd: 560,
    ts: 1_785_231_600,
  });
  assert.equal(ledger.totalPnlUsd, 140.67);
  assert.equal(ledger.size, 2);
  assert.equal(ledger.history(1)[0].pnlUsd, 140);
  assert.equal(
    ledger.history(1)[0].ts,
    1_785_231_300 + 300
  );
});

test('normalizeSettlement preserves payoutUsd and settledBy', () => {
  const row = normalizeSettlement({
    roundSlug: 'btc-updown-5m-1785231000',
    winner: 'HEDGED',
    pnlUsd: 3.86,
    costUsd: 85.71,
    payoutUsd: 89.83,
    settledBy: 'auto_balance',
    upShares: 89.83,
    downShares: 89.83,
    ts: 1_785_231_300,
  });
  assert.equal(row.payoutUsd, 89.83);
  assert.equal(row.settledBy, 'auto_balance');
  assert.equal(row.winner, 'HEDGED');
  const hist = new SettlementLedger([row]).history(1)[0];
  assert.equal(hist.payoutUsd, 89.83);
  assert.equal(hist.settledBy, 'auto_balance');
});

test('daily settled PnL uses the America/New_York calendar boundary', () => {
  const before = Date.parse('2026-07-28T03:59:59Z') / 1000;
  const after = Date.parse('2026-07-28T04:00:01Z') / 1000;
  assert.notEqual(easternDateKey(before), easternDateKey(after));

  const ledger = new SettlementLedger([
    { roundSlug: 'r-before', winner: 'UP', pnlUsd: 2, ts: before },
    { roundSlug: 'r-after', winner: 'DOWN', pnlUsd: 3, ts: after },
  ]);
  assert.equal(ledger.dailyTotal(before), 2);
  assert.equal(ledger.dailyTotal(after), 3);
  assert.equal(ledger.totalPnlUsd, 5);
});

test('engine settles a round at most once under concurrent resolution events', async () => {
  let settles = 0;
  const engine = new Engine({
    exchange: {},
    marketResolver: async () => null,
    logger: quiet,
  });
  engine.current = {
    roundSlug: 'r',
    async settle() {
      settles += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        roundSlug: 'r',
        pnlUsd: 1.25,
        pairCostMils: 990,
        matchedShares: 10,
        tiltShares: 0,
        churnRatio: 1,
      };
    },
  };

  const [first, duplicate] = await Promise.all([
    engine.onResolution('r', 'UP'),
    engine.onResolution('r', 'UP'),
  ]);
  assert.equal(first.pnlUsd, 1.25);
  assert.equal(duplicate, null);
  assert.equal(settles, 1);
  assert.equal(engine.history.length, 1);
  assert.equal(await engine.onResolution('r', 'UP'), null);
});

test('late fills are routed to their pending round, never the new current round', () => {
  const seen = [];
  const engine = new Engine({
    exchange: {},
    marketResolver: async () => null,
    logger: quiet,
  });
  engine.current = {
    roundSlug: 'new-round',
    onFill: () => seen.push('new'),
  };
  engine.pending = new Map([
    [
      'old-round',
      {
        roundSlug: 'old-round',
        onFill: () => seen.push('old'),
      },
    ],
  ]);
  const runner = engine.onFill({
    roundSlug: 'old-round',
    leg: 'UP',
    price: 0.5,
    size: 1,
  });
  assert.equal(runner.roundSlug, 'old-round');
  assert.deepEqual(seen, ['old']);
});
