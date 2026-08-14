import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityRecorder, NullRecorder } from '../src/log/recorder.js';
import * as ev from '../src/log/schema.js';
import { OrderStatus, EventType } from '../src/log/schema.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const readLines = (dir) => {
  const f = fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))[0];
  return fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
};

test('records and flushes valid JSONL', async () => {
  const dir = tmp();
  const r = new ActivityRecorder({ dir, flushMs: 10, logger: quiet });
  r.record(ev.roundOpen('rid-1', 1785140700, { UP: 'u', DOWN: 'd' }));
  r.record(ev.orderPlaced('rid-1', 20, { leg: 'UP', mils: 490, shares: 90, offsetTicks: 1, orderId: 'o1' }));
  await r.close();
  const lines = readLines(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, EventType.ROUND_OPEN);
  assert.equal(lines[1].st, OrderStatus.RESTING);
  assert.equal(lines[1].p, 490);
});

test('record() never throws and never blocks on an unserialisable event', async () => {
  const dir = tmp();
  const r = new ActivityRecorder({ dir, flushMs: 10, logger: quiet });
  const cyclic = { t: Date.now(), type: 'x' };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => r.record(cyclic));
  await r.close();
  const lines = readLines(dir);
  assert.equal(lines[0].type, 'log_error', 'bad event is replaced, not dropped silently');
});

test('ring is bounded: drops oldest instead of growing', async () => {
  const dir = tmp();
  const r = new ActivityRecorder({ dir, capacity: 8, flushMs: 100000, flushAt: 1e9, logger: quiet });
  for (let i = 0; i < 100; i++) r.record({ t: i, type: 'x', i });
  assert.equal(r.size, 8, 'ring must not grow past capacity');
  assert.equal(r.stats.dropped, 92);
  await r.close();
  const lines = readLines(dir);
  assert.equal(lines.length, 8);
  assert.equal(lines[0].i, 92, 'oldest dropped, newest kept');
});

test('a full ring does not queue an unbounded number of flush callbacks', () => {
  const dir = tmp();
  const r = new ActivityRecorder({ dir, capacity: 4, flushAt: 2, flushMs: 100000, logger: quiet });
  for (let i = 0; i < 1000; i++) r.record({ t: i, type: 'x' });
  assert.equal(r.flushScheduled, true);
  // The guard is the whole point: without it this test would have queued
  // ~1000 setImmediate callbacks and stalled the loop for ~100ms.
  r.close();
});

test('fill event carries role, fee, offset and running pair cost', async () => {
  const dir = tmp();
  const r = new ActivityRecorder({ dir, flushMs: 10, logger: quiet });
  r.record(
    ev.fill('rid-1', 45, { leg: 'UP', mils: 490, shares: 90, role: 'MAKER', fee: 0, orderId: 'o1', full: true },
      { up_bid: 500, up_ask: 510, dn_bid: 490, dn_ask: 500, own_bid: 500 },
      { up: 90, dn: 45, pairMils: 985, tilt: 45 })
  );
  await r.close();
  const [f] = readLines(dir);
  assert.equal(f.role, 'MAKER');
  assert.equal(f.fee, 0);
  assert.equal(f.st, OrderStatus.FILLED);
  assert.equal(f.off, 1, 'one tick behind the bid');
  assert.equal(f.pair, 985);
  assert.equal(f.usd, 44.1);
  assert.equal(f.type, 'WALLET_FILL');
  assert.equal(f.round_slug, 'rid-1');
  assert.equal(f.outcome, 'Up');
  assert.equal(f.side, 'BUY');
  assert.equal(f.price, 0.49);
  assert.equal(f.shares, 90);
  assert.equal(f.usdc_size, 44.1);
  assert.equal(f.best_bid_at_fill, 0.5);
});

test('settled event carries outcome and pnl', async () => {
  const dir = tmp();
  const r = new ActivityRecorder({ dir, flushMs: 10, logger: quiet });
  r.record(ev.roundSettled('rid-1', {
    winner: 'UP', matchedShares: 300, tiltShares: 20, pairCostMils: 988,
    costUsd: 300.2, payoutUsd: 320, pnlUsd: 19.8, fills: 22,
    firstFillSecond: 21, lastFillSecond: 243,
    orderStats: { placed: 180, cancelled: 160 }, churnRatio: 8.9,
  }, { feeUsd: 0, shUp: 320, shDn: 300 }));
  await r.close();
  const [s] = readLines(dir);
  assert.equal(s.outcome, 'UP');
  assert.equal(s.pnl_usd, 19.8);
  assert.equal(s.st, OrderStatus.SETTLED);
  assert.equal(s.churn, 8.9);
  assert.equal(s.type, 'ROUND_RESULT');
  assert.equal(s.round_slug, 'rid-1');
  assert.equal(s.winner, 'Up');
  assert.equal(s.pnl_usdc, 19.8);
  assert.equal(s.volume_usdc, 300.2);
  const summary = JSON.parse(
    fs.readFileSync(path.join(dir, 'round_results.json'), 'utf8')
  );
  assert.equal(summary.length, 1);
  assert.equal(summary[0].round_slug, 'rid-1');
});

test('settled PnL restores from a deduplicated mode-scoped full ledger', async () => {
  const dir = tmp();
  const slug = 'btc-updown-5m-1785231300';
  const paper = new ActivityRecorder({
    dir,
    settlementScope: 'paper',
    flushMs: 100000,
    logger: quiet,
  });
  paper.record(ev.roundSettled(slug, {
    winner: 'UP',
    matchedShares: 100,
    tiltShares: 10,
    pairCostMils: 990,
    costUsd: 100,
    payoutUsd: 110,
    grossPnlUsd: 10,
    feeUsd: 0.25,
    pnlUsd: 9.75,
    upShares: 110,
    downShares: 100,
    upAvgMils: 480,
    downAvgMils: 510,
  }));
  paper.record(ev.roundSettled(slug, {
    winner: 'UP',
    matchedShares: 100,
    tiltShares: 10,
    pairCostMils: 990,
    costUsd: 100,
    payoutUsd: 110,
    grossPnlUsd: 10,
    feeUsd: 0.2,
    pnlUsd: 9.8,
    upShares: 110,
    downShares: 100,
    upAvgMils: 480,
    downAvgMils: 510,
  }));
  await paper.close();

  const restoredPaper = new ActivityRecorder({
    dir,
    settlementScope: 'paper',
    logger: quiet,
  });
  assert.equal(restoredPaper.settledResults().length, 1);
  assert.equal(restoredPaper.settledResults()[0].pnlUsd, 9.8);
  assert.equal(restoredPaper.settledResults()[0].feeUsd, 0.2);
  assert.equal(restoredPaper.settledResults()[0].upAvgMils, 480);
  await restoredPaper.close();

  const live = new ActivityRecorder({
    dir,
    settlementScope: 'live',
    logger: quiet,
  });
  assert.deepEqual(live.settledResults(), []);
  await live.close();
  assert.ok(fs.existsSync(path.join(dir, 'pnl-paper.json')));
  assert.equal(fs.existsSync(path.join(dir, 'pnl-live.json')), false);
});

test('shutdown drains every bounded recorder batch', async () => {
  const dir = tmp();
  const recorder = new ActivityRecorder({
    dir,
    maxBatch: 32,
    capacity: 1000,
    flushMs: 100000,
    flushAt: 100000,
    logger: quiet,
  });
  for (let i = 0; i < 600; i += 1) {
    recorder.record({ t: i, type: 'bulk', i });
  }
  await recorder.close();
  assert.equal(readLines(dir).length, 600);
  assert.equal(recorder.stats.written, 600);
});

test('settlement checkpoint is durable before recorder shutdown', async () => {
  const dir = tmp();
  const recorder = new ActivityRecorder({
    dir,
    settlementScope: 'paper',
    flushMs: 100000,
    flushAt: 100000,
    logger: quiet,
  });
  await recorder.recordSettlement(
    ev.roundSettled('btc-updown-5m-1785231600', {
      winner: 'DOWN',
      costUsd: 50,
      payoutUsd: 55,
      grossPnlUsd: 5,
      feeUsd: 0.1,
      pnlUsd: 4.9,
      upShares: 45,
      downShares: 55,
      upAvgMils: 500,
      downAvgMils: 500,
    })
  );
  const persisted = JSON.parse(
    fs.readFileSync(path.join(dir, 'pnl-paper.json'), 'utf8')
  );
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].pnlUsd, 4.9);
  await recorder.close();
});

test('settlement checkpoint retries a transient sidecar failure', async () => {
  const dir = tmp();
  let pnlWrites = 0;
  const recorder = new ActivityRecorder({
    dir,
    settlementScope: 'paper',
    flushMs: 100000,
    flushAt: 100000,
    logger: quiet,
    sidecarWrite: async (file, payload) => {
      if (path.basename(file) === 'pnl-paper.json') {
        pnlWrites += 1;
        if (pnlWrites < 3) throw new Error('temporary rename failure');
      }
      await fs.promises.writeFile(file, payload, 'utf8');
    },
  });
  await recorder.recordSettlement(
    ev.roundSettled('btc-updown-5m-1785231900', {
      winner: 'UP',
      costUsd: 40,
      payoutUsd: 44,
      grossPnlUsd: 4,
      feeUsd: 0,
      pnlUsd: 4,
      upShares: 44,
      downShares: 36,
    })
  );

  assert.equal(pnlWrites, 3);
  const persisted = JSON.parse(
    fs.readFileSync(path.join(dir, 'pnl-paper.json'), 'utf8')
  );
  assert.equal(persisted[0].pnlUsd, 4);
  await recorder.close();
});

test('persistent settlement checkpoint failure is reported', async () => {
  const dir = tmp();
  let pnlWrites = 0;
  const recorder = new ActivityRecorder({
    dir,
    settlementScope: 'paper',
    flushMs: 100000,
    flushAt: 100000,
    logger: quiet,
    sidecarWrite: async (file, payload) => {
      if (path.basename(file) === 'pnl-paper.json') {
        pnlWrites += 1;
        throw new Error('disk offline');
      }
      await fs.promises.writeFile(file, payload, 'utf8');
    },
  });

  await assert.rejects(
    () =>
      recorder.recordSettlement(
        ev.roundSettled('btc-updown-5m-1785232200', {
          winner: 'DOWN',
          costUsd: 40,
          payoutUsd: 42,
          grossPnlUsd: 2,
          feeUsd: 0,
          pnlUsd: 2,
          upShares: 38,
          downShares: 42,
        })
      ),
    /settlement checkpoint failed: disk offline/
  );
  assert.equal(pnlWrites, 3);
  assert.equal(fs.existsSync(path.join(dir, 'pnl-paper.json')), false);
  await recorder.close();
});

test('NullRecorder is a safe no-op', async () => {
  assert.doesNotThrow(() => NullRecorder.record({ anything: true }));
  assert.deepEqual(NullRecorder.settledResults(), []);
  await NullRecorder.close();
});

test('record() stays sub-microsecond', () => {
  const dir = tmp();
  const r = new ActivityRecorder({ dir, flushMs: 100000, flushAt: 1e9, capacity: 200000, logger: quiet });
  const e = ev.orderPlaced('rid', 100, { leg: 'UP', mils: 490, shares: 90, offsetTicks: 1, orderId: 'o' });
  for (let i = 0; i < 20000; i++) r.record(e);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100000; i++) r.record(e);
  const perCall = Number(process.hrtime.bigint() - t0) / 1000 / 100000;
  assert.ok(perCall < 1.0, `record() took ${perCall.toFixed(3)}us per call, budget is 1us`);
  r.close();
});

// ------------------------------------------------- intent log deduplication
import { RoundRunner } from '../src/roundRunner.js';
import { LegBook, MarketBook } from '../src/book.js';
import { PaperExchange } from '../src/exchange/paperExchange.js';
import { PARAMS } from '../src/config.js';

function books(bb) {
  const mk = (b) => {
    const bids = [], asks = [];
    for (let i = 0; i < 12; i++) {
      if (b - i >= 1) bids.push({ price: (b - i) / 100, size: 400 });
      if (b + 1 + i <= 99) asks.push({ price: (b + 1 + i) / 100, size: 400 });
    }
    return new LegBook(bids, asks, 0);
  };
  return new MarketBook(mk(bb), mk(99 - bb));
}

test('identical intents are not re-logged; changes and heartbeats are', async () => {
  const dir = tmp();
  const rec = new ActivityRecorder({ dir, flushMs: 10, logger: quiet });
  const ws = 1785167100;
  const r = new RoundRunner({
    roundSlug: `btc-updown-5m-${ws}`,
    windowStartEpoch: ws,
    tokenIds: { UP: 'UP', DOWN: 'DOWN' },
    exchange: new PaperExchange(),
    recorder: rec,
    logger: quiet,
    params: { ...PARAMS, BOOK_SNAPSHOT_MS: 1e9 },
  });

  // 40 updates at an unchanged touch: one intent, not forty.
  for (let i = 0; i < 40; i++) await r.onBook(books(50), ws + 60 + i * 0.01, 1000 + i);
  // touch moves: a new intent
  await r.onBook(books(48), ws + 61, 1400);
  await rec.close();

  const intents = readLines(dir).filter((e) => e.type === EventType.QUOTE_INTENT);
  assert.equal(intents.length, 2, `expected 2 intents, got ${intents.length}`);
  assert.equal(intents[0].rungs[0].p, 490);
  assert.equal(intents[1].rungs[0].p, 470);
});

test('heartbeat still fires on a completely static book', async () => {
  const dir = tmp();
  const rec = new ActivityRecorder({ dir, flushMs: 10, logger: quiet });
  const ws = 1785167100;
  const r = new RoundRunner({
    roundSlug: `btc-updown-5m-${ws}`,
    windowStartEpoch: ws,
    tokenIds: { UP: 'UP', DOWN: 'DOWN' },
    exchange: new PaperExchange(),
    recorder: rec,
    logger: quiet,
    params: { ...PARAMS, INTENT_HEARTBEAT_MS: 100, BOOK_SNAPSHOT_MS: 1e9 },
  });
  await r.onBook(books(50), ws + 60, 1000);
  await r.onBook(books(50), ws + 61, 1050);   // inside heartbeat window
  await r.onBook(books(50), ws + 62, 1200);   // past it
  await rec.close();
  const intents = readLines(dir).filter((e) => e.type === EventType.QUOTE_INTENT);
  assert.equal(intents.length, 2, 'a quiet book must still leave a trail');
});

test('periodic book snapshot captures ask-only moves', async () => {
  const dir = tmp();
  const rec = new ActivityRecorder({ dir, flushMs: 10, logger: quiet });
  const ws = 1785167100;
  const r = new RoundRunner({
    roundSlug: `btc-updown-5m-${ws}`,
    windowStartEpoch: ws,
    tokenIds: { UP: 'UP', DOWN: 'DOWN' },
    exchange: new PaperExchange(),
    recorder: rec,
    logger: quiet,
    params: { ...PARAMS, BOOK_SNAPSHOT_MS: 100 },
  });
  await r.onBook(books(50), ws + 60, 1000);
  await r.onBook(books(50), ws + 61, 1200);
  await rec.close();
  const snaps = readLines(dir).filter((e) => e.type === EventType.BOOK_SNAPSHOT);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].up_bid, 500);
  assert.equal(snaps[0].type, 'TICK');
  assert.equal(snaps[0].round_slug, `btc-updown-5m-${ws}`);
  assert.equal(snaps[0].best_bid_up, 0.5);
  const latest = JSON.parse(
    fs.readFileSync(path.join(dir, 'latest_state.json'), 'utf8')
  );
  assert.equal(latest.type, 'TICK');
  assert.equal(latest.best_bid_up, 0.5);
});

test('health snapshots are written to the log, not only the console', async () => {
  const dir = tmp();
  const rec = new ActivityRecorder({ dir, flushMs: 10, logger: quiet });
  rec.record(ev.health({ round: 'r', liveOrders: 4, userFeedHealthy: true, staleBooksDropped: 0 }));
  await rec.close();
  const [h] = readLines(dir);
  assert.equal(h.type, EventType.HEALTH);
  assert.equal(h.liveOrders, 4);
  assert.equal(h.userFeedHealthy, true);
});

test('target events file contains only strict tracker-compatible records', async () => {
  const dir = tmp();
  const rec = new ActivityRecorder({
    dir,
    prefix: 'activity',
    targetCompatible: true,
    flushMs: 10,
    logger: quiet,
  });
  const books = {
    UP: {
      bids: [{ mils: 500, size: 100 }],
      asks: [{ mils: 510, size: 110 }],
    },
    DOWN: {
      bids: [{ mils: 490, size: 110 }],
      asks: [{ mils: 500, size: 100 }],
    },
  };
  rec.record(ev.health({ ready: true }));
  rec.record(
    ev.bookSnapshot(
      'btc-updown-5m-1000',
      20,
      {
        up_bid: 500,
        up_ask: 510,
        dn_bid: 490,
        dn_ask: 500,
        net_shares_up: 20,
        net_shares_down: 10,
      },
      books
    )
  );
  await rec.close();
  const targetPath = fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name))
    .find((name) => path.basename(name).startsWith('events-'));
  const rows = fs
    .readFileSync(targetPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  assert.equal(rows.length, 1, 'HEALTH must remain in activity log only');
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'best_ask_down', 'best_ask_up', 'best_bid_down', 'best_bid_up',
    'binance_btc_usd', 'daily_date_et', 'daily_volume_usdc', 'down_book',
    'last_round', 'market_winner', 'net_shares_down', 'net_shares_up',
    'polymarket_btc_usd', 'price_to_beat', 'price_to_beat_source',
    'round_slug', 'round_volume_usdc', 'seconds_into_round',
    'seconds_remaining', 'ts', 'type', 'up_book', 'up_token_implied_prob',
    'wallet_pnl_usdc',
  ].sort());
  assert.deepEqual(rows[0].up_book.bids, [{ price: 0.5, size: 100 }]);
});

test('latest_state writes are serialized and coalesce to the newest price', async () => {
  const dir = tmp();
  let releaseFirst;
  let signalFirstStarted;
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve;
  });
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const writtenTs = [];
  const rec = new ActivityRecorder({
    dir,
    flushMs: 1,
    flushAt: 1,
    logger: quiet,
    sidecarWrite: async (file, payload) => {
      const row = JSON.parse(payload);
      if (path.basename(file) === 'latest_state.json') {
        writtenTs.push(row.ts);
        if (row.ts === 1) {
          signalFirstStarted();
          await firstBlocked;
        }
      }
      await fs.promises.writeFile(file, payload);
    },
  });
  const tick = (ts, upBid) => {
    const row = ev.bookSnapshot('btc-updown-5m-1000', ts, {
      up_bid: upBid,
      up_ask: upBid + 10,
      dn_bid: 990 - upBid,
      dn_ask: 1000 - upBid,
    });
    row.ts = ts;
    return row;
  };

  rec.record(tick(1, 500));
  await firstStarted;
  rec.record(tick(2, 510));
  rec.record(tick(3, 520));
  const closing = rec.close();
  // close() has synchronously drained the remaining TICKs into the pending
  // sidecar slot before it begins awaiting the blocked writer.
  releaseFirst();
  await closing;

  const latest = JSON.parse(
    fs.readFileSync(path.join(dir, 'latest_state.json'), 'utf8')
  );
  assert.deepEqual(writtenTs, [1, 3], 'intermediate state should be coalesced');
  assert.equal(latest.ts, 3);
  assert.equal(latest.best_bid_up, 0.52);
});
