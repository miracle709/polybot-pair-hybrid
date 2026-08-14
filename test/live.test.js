import test from 'node:test';
import assert from 'node:assert/strict';
import { BookState } from '../src/live/bookState.js';
import { RateLimiter, PRIORITY } from '../src/live/rateLimiter.js';
import { MarketResolver } from '../src/live/marketResolver.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('book snapshot then deltas produce the right touch', () => {
  const s = new BookState('asset-up', { logger: quiet });
  s.applySnapshot({
    bids: [{ price: '0.50', size: '300' }, { price: '0.49', size: '200' }],
    asks: [{ price: '0.51', size: '250' }],
    timestamp: 1785140700000,
  });
  let b = s.toLegBook();
  assert.equal(b.bestBid, 500);
  assert.equal(b.bestAsk, 510);
  assert.equal(b.midMils, 505);

  s.applyDelta({ changes: [{ price: '0.51', size: '0', side: 'SELL' }, { price: '0.52', size: '100', side: 'SELL' }] });
  b = s.toLegBook();
  assert.equal(b.bestAsk, 520, 'size 0 must REMOVE the level, not zero it');
  assert.equal(b.spreadMils, 20);
});

test('sub-cent tail levels survive delta application', () => {
  const s = new BookState('a', { logger: quiet });
  s.applySnapshot({ bids: [{ price: '0.05', size: '100' }], asks: [{ price: '0.984', size: '50' }] });
  s.applyDelta({ changes: [{ price: '0.991', size: '75', side: 'SELL' }] });
  const b = s.toLegBook();
  assert.equal(b.bestAsk, 984);
  assert.ok(b.asks.some((l) => l.mils === 991));
});

test('flat (non-batched) delta shape is accepted', () => {
  const s = new BookState('a', { logger: quiet });
  s.applySnapshot({ bids: [{ price: '0.40', size: '10' }], asks: [{ price: '0.41', size: '10' }] });
  assert.equal(s.applyDelta({ price: '0.42', size: '5', side: 'SELL' }), true);
  assert.equal(s.toLegBook().asks.length, 2);
});

test('authoritative best prices reject a silently stale reconstructed touch', () => {
  const s = new BookState('a', { logger: quiet });
  s.applySnapshot({
    bids: [{ price: '0.50', size: '10' }, { price: '0.49', size: '10' }],
    asks: [{ price: '0.51', size: '10' }],
  });
  // Simulate a missed removal at 0.50. The incoming row says the venue's
  // actual best bid is now 0.49 even though our stale map still has 0.50.
  assert.equal(
    s.applyDelta({
      changes: [{
        price: '0.49',
        size: '20',
        side: 'BUY',
        best_bid: '0.49',
        best_ask: '0.51',
      }],
    }),
    true
  );
  assert.equal(s.toLegBook(), null);
  assert.equal(s.needsResync, true);
  assert.equal(s.stats.resyncs, 1);
});

test('unknown delta side is rejected instead of corrupting asks', () => {
  const s = new BookState('a', { logger: quiet });
  s.applySnapshot({
    bids: [{ price: '0.50', size: '10' }],
    asks: [{ price: '0.51', size: '10' }],
  });
  assert.equal(
    s.applyDelta({
      changes: [{ price: '0.52', size: '50', side: 'UNKNOWN' }],
    }),
    false
  );
  assert.equal(s.needsResync, true);
  assert.equal(s.asks.has(520), false);
});

test('unrecognised delta shape flags a resync instead of silently no-oping', () => {
  const s = new BookState('a', { logger: quiet });
  s.applySnapshot({ bids: [{ price: '0.40', size: '10' }], asks: [{ price: '0.41', size: '10' }] });
  assert.equal(s.applyDelta({ something: 'else' }), false);
  assert.equal(s.needsResync, true);
  assert.equal(s.toLegBook(), null, 'must not serve a book it cannot verify');
});

test('a crossed book after deltas triggers resync', () => {
  const s = new BookState('a', { logger: quiet });
  s.applySnapshot({ bids: [{ price: '0.50', size: '10' }], asks: [{ price: '0.51', size: '10' }] });
  s.applyDelta({ changes: [{ price: '0.49', size: '10', side: 'SELL' }] });
  assert.equal(s.toLegBook(), null);
  assert.equal(s.needsResync, true);
});

test('deltas before any snapshot flag a resync', () => {
  const s = new BookState('a', { logger: quiet });
  assert.equal(s.applyDelta({ changes: [{ price: '0.5', size: '1', side: 'BUY' }] }), false);
  assert.equal(s.needsResync, true);
});

test('rate limiter runs cancels ahead of queued places', async () => {
  const rl = new RateLimiter({ capacity: 1, refillPerSec: 50, logger: quiet });
  await rl.acquire(1, PRIORITY.PLACE); // drain the bucket
  const order = [];
  const p1 = rl.acquire(1, PRIORITY.PLACE).then(() => order.push('place'));
  const p2 = rl.acquire(1, PRIORITY.CANCEL).then(() => order.push('cancel'));
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['cancel', 'place'], 'a queued cancel must not sit behind places');
});

test('rate limiter sheds load rather than queueing forever', async () => {
  const rl = new RateLimiter({ capacity: 1, refillPerSec: 0.01, maxQueue: 2, logger: quiet });
  await rl.acquire(1);
  const a = rl.acquire(1).catch((e) => e.message);
  const b = rl.acquire(1).catch((e) => e.message);
  await assert.rejects(() => rl.acquire(1), /queue full/);
  rl.drainAndReject('test teardown');
  await Promise.all([a, b]);
});

test('market parsing maps UP and DOWN to the correct token ids', () => {
  const stringy = MarketResolver.parseMarket(
    {
      clobTokenIds: '["111","222"]',
      outcomes: '["Up","Down"]',
      conditionId: '0xabc',
    },
    'btc-updown-5m-1785140700'
  );
  assert.equal(stringy.tokenIds.UP, '111');
  assert.equal(stringy.tokenIds.DOWN, '222');

  // Reversed ordering must follow `outcomes`, not array position.
  const reversed = MarketResolver.parseMarket(
    { clobTokenIds: ['111', '222'], outcomes: ['Down', 'Up'], conditionId: '0xabc' },
    'x'
  );
  assert.equal(reversed.tokenIds.UP, '222', 'UP must follow the outcomes array, not index 0');
  assert.equal(reversed.tokenIds.DOWN, '111');
});

test('unrecognised outcomes throw rather than guessing which leg is UP', () => {
  assert.throws(
    () => MarketResolver.parseMarket({ clobTokenIds: ['1', '2'], outcomes: ['A', 'B'] }, 'x'),
    /unrecognised outcomes/
  );
});

test('resolver caches and prefetches the next window', async () => {
  let calls = 0;
  const fake = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => [{ clobTokenIds: '["1","2"]', outcomes: '["Up","Down"]', conditionId: '0x1' }],
    };
  };
  const r = new MarketResolver({ logger: quiet, fetchImpl: fake });
  await r.resolve(1785140700);
  await r.resolve(1785140700);
  assert.equal(calls, 1, 'second resolve must hit cache');
  r.prefetchNext(1785140700);
  await r.resolve(1785141000);
  assert.equal(calls, 2, 'prefetched window must not refetch');
});

test('resolver captures trusted Gamma time even when a market is absent', async () => {
  const serverDate = 'Tue, 28 Jul 2026 09:21:06 GMT';
  const r = new MarketResolver({
    logger: quiet,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'date' ? serverDate : null },
      json: async () => [],
    }),
  });

  await assert.rejects(
    () => r.resolve(1_785_231_600),
    /no market/
  );
  assert.equal(
    r.lastServerEpochSeconds,
    Date.parse(serverDate) / 1000
  );
  assert.equal(r.cache.size, 0, 'an absent market must remain retryable');
});

test('resolver rejects token ids returned for a different market slug', async () => {
  const requested = 1_785_231_600;
  const r = new MarketResolver({
    logger: quiet,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [{
        slug: 'btc-updown-5m-1785231300',
        clobTokenIds: '["wrong-up","wrong-down"]',
        outcomes: '["Up","Down"]',
      }],
    }),
  });

  await assert.rejects(
    () => r.resolve(requested),
    /returned btc-updown-5m-1785231300 while resolving btc-updown-5m-1785231600/
  );
  assert.equal(r.cache.size, 0);
});

// ---------------------------------------------------------- price to beat
import { HttpPriceToBeatProvider, StaticPriceToBeatProvider } from '../src/live/priceToBeat.js';
import { PolymarketLiveAdapter } from '../src/exchange/polymarketLive.js';
import { RateLimiter as RL } from '../src/live/rateLimiter.js';

test('price-to-beat parses the tracker TICK shape', () => {
  const tick = {
    round_slug: 'btc-updown-5m-1785140700',
    seconds_into_round: 29,
    price_to_beat: 65159.581,
    price_to_beat_source: 'chainlink_open',
    polymarket_btc_usd: 65171.31,
    binance_btc_usd: 65231.96,
  };
  const p = HttpPriceToBeatProvider.parse(tick, 'btc-updown-5m-1785140700');
  assert.equal(p.ptb, 65159.581);
  assert.equal(p.src, 'chainlink_open');
  assert.equal(p.binance, 65231.96);
});

test('price-to-beat rejects a payload from a different round', () => {
  const tick = { round_slug: 'btc-updown-5m-1785140400', price_to_beat: 65159 };
  assert.equal(HttpPriceToBeatProvider.parse(tick, 'btc-updown-5m-1785140700'), null);
});

test('price-to-beat rejects a payload with no strike', () => {
  assert.equal(HttpPriceToBeatProvider.parse({ price_to_beat: null }, null), null);
  assert.equal(HttpPriceToBeatProvider.parse({}, null), null);
});

test('http provider gives up after the timeout rather than hanging', async () => {
  const p = new HttpPriceToBeatProvider({
    url: 'http://x',
    pollMs: 5,
    timeoutMs: 40,
    logger: quiet,
    fetchImpl: async () => ({ ok: true, json: async () => ({ price_to_beat: null }) }),
  });
  assert.equal(await p.fetchFor('rid'), null);
  assert.ok(p.stats.misses > 0);
});

test('static provider round-trips a known value', async () => {
  const v = { ptb: 1, src: 'test', poly: null, binance: null, sec: null };
  assert.deepEqual(await new StaticPriceToBeatProvider(v).fetchFor('rid'), v);
});

test('live adapter has no send-nothing mode and submits through the CLOB client', async () => {
  const { Side, OrderType } = await import('@polymarket/clob-client-v2');
  const calls = [];
  const client = {
    async createOrder(order, options) {
      calls.push(['create', order, options]);
      return { signed: true };
    },
    async postOrder(...args) {
      calls.push(['post', ...args]);
      return { orderID: 'live-1' };
    },
    async cancelOrders(ids) {
      calls.push(['cancel', ids]);
    },
    async cancelAll() {},
    async getOpenOrders() {
      return [];
    },
    async getBalanceAllowance() {
      return { balance: '0' };
    },
  };
  const limiter = new RL({ capacity: 10, refillPerSec: 1000, logger: quiet });
  const adapter = new PolymarketLiveAdapter({ client, limiter, logger: quiet });
  const placed = await adapter.placeLimitBuy({ tokenId: 't', price: 0.49, size: 90 });
  await adapter.cancelOrders([placed.orderId]);
  assert.equal(placed.orderId, 'live-1');
  assert.deepEqual(calls.map((call) => call[0]), ['create', 'post', 'cancel']);
  assert.equal(calls[0][1].side, Side.BUY);
  assert.deepEqual(calls[0][2], { tickSize: '0.01', negRisk: false });
  assert.deepEqual(calls[1].slice(1), [{ signed: true }, OrderType.GTC, false]);
  assert.equal(adapter.mode, 'live');
});

test('live adapter sends ordinary quotes as post-only when requested', async () => {
  const { OrderType } = await import('@polymarket/clob-client-v2');
  const posts = [];
  const client = {
    async createOrder() { return { signed: true }; },
    async postOrder(...args) {
      posts.push(args);
      return { orderID: 'po-1' };
    },
    async cancelOrders() {},
    async getOpenOrders() { return []; },
    async getBalanceAllowance() { return { balance: '0' }; },
  };
  const adapter = new PolymarketLiveAdapter({
    client,
    limiter: new RL({ capacity: 10, refillPerSec: 1000, logger: quiet }),
    logger: quiet,
  });
  await adapter.placeLimitBuy({
    tokenId: 't',
    price: 0.49,
    size: 10,
    postOnly: true,
  });
  assert.deepEqual(posts[0], [{ signed: true }, OrderType.GTC, true]);
});

test('live adapter posts FAK hedges as OrderType.FAK without post-only', async () => {
  const { OrderType } = await import('@polymarket/clob-client-v2');
  const posts = [];
  const client = {
    async createOrder() { return { signed: true }; },
    async postOrder(...args) {
      posts.push(args);
      return {
        orderID: 'fak-1',
        takingAmount: '10',
        makingAmount: '5.2',
        status: 'matched',
      };
    },
    async cancelOrders() {},
    async getOpenOrders() { return []; },
    async getBalanceAllowance() { return { balance: '0' }; },
  };
  const adapter = new PolymarketLiveAdapter({
    client,
    limiter: new RL({ capacity: 10, refillPerSec: 1000, logger: quiet }),
    logger: quiet,
  });
  const placed = await adapter.placeLimitBuy({
    tokenId: 't',
    price: 0.52,
    size: 10,
    orderType: 'FAK',
    postOnly: true,
  });
  assert.deepEqual(posts[0], [{ signed: true }, OrderType.FAK, false]);
  assert.equal(placed.filledShares, 10);
  assert.ok(Math.abs(placed.avgPrice - 0.52) < 1e-9);
});

test('live adapter falls back to getOrder when FAK response omits amounts', async () => {
  const client = {
    async createOrder() { return { signed: true }; },
    async postOrder() {
      return { orderID: 'fak-2', status: 'live' };
    },
    async getOrder(id) {
      assert.equal(id, 'fak-2');
      return {
        id: 'fak-2',
        size_matched: '7',
        original_size: '10',
        price: '0.55',
        status: 'MATCHED',
      };
    },
    async cancelOrders() {},
    async getOpenOrders() { return []; },
    async getBalanceAllowance() { return { balance: '0' }; },
  };
  const adapter = new PolymarketLiveAdapter({
    client,
    limiter: new RL({ capacity: 10, refillPerSec: 1000, logger: quiet }),
    logger: quiet,
  });
  const placed = await adapter.placeLimitBuy({
    tokenId: 't',
    price: 0.55,
    size: 10,
    orderType: 'FAK',
  });
  assert.equal(placed.filledShares, 7);
  assert.equal(placed.avgPrice, 0.55);
});

test('live adapter refuses construction without a client', () => {
  assert.throws(() => new PolymarketLiveAdapter({ client: null, logger: quiet }), /requires a CLOB client/);
});

test('live adapter refuses clients missing exact V2 methods', () => {
  assert.throws(
    () =>
      new PolymarketLiveAdapter({
        client: { createOrder() {}, postOrder() {} },
        logger: quiet,
      }),
    /missing cancelOrders, getOpenOrders, getBalanceAllowance/
  );
});

test('live adapter resolves and caches per-token tick size and negRisk', async () => {
  const optionsSeen = [];
  let tickLookups = 0;
  let negRiskLookups = 0;
  const client = {
    async getTickSize() {
      tickLookups += 1;
      return '0.001';
    },
    async getNegRisk() {
      negRiskLookups += 1;
      return true;
    },
    async createOrder(_order, options) {
      optionsSeen.push(options);
      return { signed: true };
    },
    async postOrder() {
      return { orderID: `tail-${optionsSeen.length}` };
    },
    async cancelOrders() {},
    async getOpenOrders() {
      return [];
    },
    async getBalanceAllowance() {
      return { balance: '0' };
    },
  };
  const limiter = new RL({ capacity: 10, refillPerSec: 1000, logger: quiet });
  const adapter = new PolymarketLiveAdapter({ client, limiter, logger: quiet });
  await adapter.placeLimitBuy({ tokenId: 'tail', price: 0.999, size: 10 });
  await adapter.placeLimitBuy({ tokenId: 'tail', price: 0.998, size: 10 });

  assert.equal(tickLookups, 1);
  assert.equal(negRiskLookups, 1);
  assert.deepEqual(optionsSeen, [
    { tickSize: '0.001', negRisk: true },
    { tickSize: '0.001', negRisk: true },
  ]);
});

// ------------------------------------------------------- rollover integrity
import { MarketFeed, UserFeed } from '../src/live/feeds.js';
import { OrderManager } from '../src/orderManager.js';
import { PARAMS as P } from '../src/config.js';
import { PaperExchange } from '../src/exchange/paperExchange.js';
import { LegBook, MarketBook } from '../src/book.js';
import { StatusServer } from '../src/live/statusServer.js';
import { Supervisor } from '../src/live/supervisor.js';

test('paper exchange turns real book queue shrinkage into simulated fills', async () => {
  const fills = [];
  const paper = new PaperExchange({
    queueAheadFactor: 0,
    tradeFraction: 1,
    placeLatencyMs: 0,
    cancelLatencyMs: 0,
    feeBps: 10,
  });
  paper.setFillHandler((fill) => fills.push(fill));
  paper.setMarket({ roundSlug: 'r', tokenIds: { UP: 'u', DOWN: 'd' } });
  paper.setClock(1000);
  await paper.placeLimitBuy({
    tokenId: 'u', price: 0.49, size: 90, roundSlug: 'r', offsetTicks: 1,
  });
  const leg = (bidSize, ts) =>
    new LegBook(
      [{ price: 0.49, size: bidSize }, { price: 0.48, size: 100 }],
      [{ price: 0.5, size: 100 }],
      ts
    );
  paper.onMarketBook(new MarketBook(leg(100, 1), leg(100, 1)), 1, 'r');
  paper.onMarketBook(new MarketBook(leg(50, 2), leg(100, 2)), 2, 'r');

  assert.equal(fills.length, 1);
  assert.equal(fills[0].leg, 'UP');
  assert.equal(fills[0].size, 50);
  assert.ok(fills[0].fee > 0);
  assert.equal(paper.paperSummary().openOrders, 1);
});

test('paper exchange preserves a realistic token id alongside its mapped leg', async () => {
  const upToken =
    '57743335247669342964455981611407748442448264728082512501322343255377996735108';
  const downToken =
    '45103774645616183160407049777349486565609107139992967770755543558295528141347';
  const paper = new PaperExchange();
  paper.setMarket({
    roundSlug: 'btc-updown-5m-1785380100',
    tokenIds: { UP: upToken, DOWN: downToken },
  });

  const { orderId } = await paper.placeLimitBuy({
    tokenId: upToken,
    price: 0.49,
    size: 90,
    roundSlug: 'btc-updown-5m-1785380100',
  });

  assert.equal(paper.open.get(orderId).tokenId, upToken);
  assert.equal(paper.open.get(orderId).leg, 'UP');
});

test('Supervisor paper activation preserves realistic token ids and mapped legs', async () => {
  const upToken =
    '57743335247669342964455981611407748442448264728082512501322343255377996735108';
  const downToken =
    '45103774645616183160407049777349486565609107139992967770755543558295528141347';
  const paper = new PaperExchange();
  const supervisor = new Supervisor({
    adapter: paper,
    logger: quiet,
    params: { ...P, ASSUMED_FEE_BPS_OF_NOTIONAL: 0 },
    log: { enabled: false },
  });
  const windowStart = Math.floor(Date.now() / 1000 / P.ROUND_SECONDS) * P.ROUND_SECONDS;
  const roundSlug = `btc-updown-5m-${windowStart}`;
  supervisor.resolver.resolve = async () => ({
    roundSlug,
    conditionId: '0x' + 'ab'.repeat(32),
    tokenIds: { UP: upToken, DOWN: downToken },
    upIndex: 0,
    downIndex: 1,
  });
  supervisor.resolver.prefetchNext = () => {};
  supervisor.marketFeed.subscribe = () => {};
  const sigintBefore = new Set(process.rawListeners('SIGINT'));
  const sigtermBefore = new Set(process.rawListeners('SIGTERM'));

  try {
    await supervisor.start();
    const desired = [{
      leg: 'DOWN',
      mils: 490,
      shares: 90,
      offsetTicks: 1,
      key: 'DOWN@490',
    }];
    await supervisor.engine.current.orders.reconcile(
      desired,
      { roundSlug, tokenIds: { UP: upToken, DOWN: downToken } },
      Date.now()
    );

    const [order] = [...paper.open.values()];
    assert.equal(order.tokenId, downToken);
    assert.equal(order.leg, 'DOWN');
    assert.equal(paper.market.tokenIds.DOWN, downToken);
  } finally {
    await supervisor.shutdown('test');
    for (const listener of process.rawListeners('SIGINT')) {
      if (!sigintBefore.has(listener)) process.removeListener('SIGINT', listener);
    }
    for (const listener of process.rawListeners('SIGTERM')) {
      if (!sigtermBefore.has(listener)) process.removeListener('SIGTERM', listener);
    }
  }
});

test('dashboard polling serves a cached snapshot without re-reading the engine', async () => {
  let healthReads = 0;
  const supervisor = {
    health() {
      healthReads += 1;
      return { ready: true, mode: 'paper', market: [], recorder: {} };
    },
    engine: {
      current: { orders: { live: new Map() } },
      history: [],
    },
  };
  const status = new StatusServer({
    supervisor,
    port: 0,
    host: '127.0.0.1',
    snapshotMs: 10000,
    logger: quiet,
  });
  const server = status.start();
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const responses = await Promise.all(
    Array.from({ length: 12 }, () =>
      fetch(`http://127.0.0.1:${port}/api/status`).then((res) => res.json())
    )
  );
  assert.equal(healthReads, 1, 'HTTP requests must not call supervisor.health()');
  assert.ok(responses.every((body) => body.monitor?.cached === true));
  assert.ok(responses.every((body) => Array.isArray(body.orders)));
  assert.ok(responses.every((body) => Array.isArray(body.rounds)));
  await status.close();
});

test('POST /api/auto-balance invokes supervisor and returns the result', async () => {
  let calls = 0;
  const supervisor = {
    health: () => ({ ready: true, mode: 'paper', market: [], recorder: {} }),
    engine: { current: { orders: { live: new Map() } }, history: [] },
    async autoBalance() {
      calls += 1;
      return {
        ok: true,
        paused: true,
        cancelled: 2,
        tiltAfter: 0,
        lockedPnlUsd: 1.8,
        hedges: [{ leg: 'DOWN', shares: 10, price: 0.99, orderId: 'h1' }],
      };
    },
  };
  const status = new StatusServer({
    supervisor,
    port: 0,
    host: '127.0.0.1',
    snapshotMs: 10000,
    logger: quiet,
  });
  const server = status.start();
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/auto-balance`, {
    method: 'POST',
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.equal(body.ok, true);
  assert.equal(body.lockedPnlUsd, 1.8);
  await status.close();
});

test('POST /api/auto-balance requires the configured token', async () => {
  const supervisor = {
    health: () => ({ ready: true, mode: 'paper', market: [], recorder: {} }),
    engine: { current: { orders: { live: new Map() } }, history: [] },
    async autoBalance() {
      return { ok: true, lockedPnlUsd: 0 };
    },
  };
  const status = new StatusServer({
    supervisor,
    port: 0,
    host: '127.0.0.1',
    token: 'secret',
    snapshotMs: 10000,
    logger: quiet,
  });
  const server = status.start();
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const denied = await fetch(`http://127.0.0.1:${port}/api/auto-balance`, {
    method: 'POST',
  });
  assert.equal(denied.status, 401);
  const ok = await fetch(
    `http://127.0.0.1:${port}/api/auto-balance?token=secret`,
    { method: 'POST' }
  );
  assert.equal(ok.status, 200);
  await status.close();
});

test('Supervisor.autoBalance FAK-hedges flat, locks PnL once, skips re-settle', async () => {
  const { LegBook } = await import('../src/book.js');
  const { RoundRunner, RoundState } = await import('../src/roundRunner.js');
  const { SettlementLedger } = await import('../src/live/settlementLedger.js');
  const { PaperExchange } = await import('../src/exchange/paperExchange.js');

  const paper = new PaperExchange({
    placeLatencyMs: 300,
    cancelLatencyMs: 0,
    takerFeeRate: 0,
    feeBps: 0,
  });
  paper.setMarket({
    roundSlug: 'btc-updown-5m-1',
    tokenIds: { UP: 'tok-up', DOWN: 'tok-down' },
  });

  const runner = new RoundRunner({
    roundSlug: 'btc-updown-5m-1',
    windowStartEpoch: 1,
    tokenIds: { UP: 'tok-up', DOWN: 'tok-down' },
    exchange: paper,
    logger: quiet,
    recorder: { record() {}, async recordSettlement() {} },
  });
  runner.inventory.addFill('UP', 400, 20, 1);
  runner.inventory.addFill('DOWN', 500, 10, 1);
  runner.state = RoundState.QUOTING;
  runner.feeUsd = 0;

  paper.setFillHandler((fill) => {
    runner.onFill({
      leg: fill.leg,
      price: fill.price,
      size: fill.size,
      fee: fill.fee ?? 0,
      ts: fill.ts,
      orderId: fill.orderId,
      role: fill.role,
      full: fill.full,
    });
  });

  const downBook = new LegBook(
    [{ price: 0.51, size: 100 }],
    [{ price: 0.52, size: 100 }],
    10
  );

  const supervisor = Object.create(Supervisor.prototype);
  supervisor.autoBalanceInFlight = false;
  supervisor.halted = false;
  supervisor.haltReason = null;
  supervisor.logger = quiet;
  supervisor.pausedRound = null;
  supervisor.pauseReason = null;
  supervisor.currentMarket = {
    roundSlug: 'btc-updown-5m-1',
    tokenIds: { UP: 'tok-up', DOWN: 'tok-down' },
  };
  supervisor.lastBooks = {
    UP: new LegBook([{ price: 0.4, size: 50 }], [{ price: 0.41, size: 50 }], 10),
    DOWN: downBook,
  };
  supervisor.adapter = paper;
  supervisor.settlements = new SettlementLedger();
  supervisor.sessionSettledPnlUsd = 0;
  supervisor.settlementPersistenceEnabled = true;
  const removedPending = [];
  supervisor.pendingSettlements = {
    remove(slug) {
      removedPending.push(slug);
    },
    get() {
      return null;
    },
  };
  supervisor.pendingCaptureByRound = new Map();
  supervisor.accountingUncertainRounds = new Set();
  supervisor.settlingRounds = new Set();
  supervisor.recorder = { record() {}, async recordSettlement() {} };
  supervisor.marketClock = { nowEpochSeconds: () => 100 };
  supervisor.engine = {
    current: runner,
    settledRounds: new Set(),
    history: [],
    pending: new Map(),
    async onResolution() {
      throw new Error('must not re-settle via engine');
    },
  };

  assert.equal(runner.inventory.tiltShares(), 10);
  const result = await supervisor.autoBalance();
  assert.equal(result.ok, true);
  assert.equal(result.tiltAfter, 0);
  assert.equal(runner.inventory.tiltShares(), 0);
  assert.equal(runner.state, RoundState.DONE);
  assert.ok(result.hedges.length >= 1);
  assert.equal(result.hedges[0].leg, 'DOWN');
  assert.equal(result.hedges[0].mils, 560);
  assert.equal(result.hedges[0].economicCapMils, 560);
  assert.ok(paper.fills.some((f) => f.role === 'TAKER'));
  // matched 20, cost 8+5+5.2=18.2 → locked 1.8
  assert.equal(result.lockedPnlUsd, 1.8);
  assert.ok(supervisor.settlements.has('btc-updown-5m-1'));
  assert.equal(
    supervisor.settlements.byRound.get('btc-updown-5m-1').winner,
    'HEDGED'
  );

  const sessionBefore = supervisor.sessionSettledPnlUsd;
  const lockedPnl = supervisor.settlements.byRound.get('btc-updown-5m-1').pnlUsd;
  const again = await supervisor.onResolution('btc-updown-5m-1', 'UP');
  assert.equal(again.settledBy, 'auto_balance');
  assert.equal(again.winner, 'UP');
  assert.equal(again.resolvedWinner, 'UP');
  assert.equal(again.pnlUsd, lockedPnl);
  assert.ok(Number.isFinite(again.payoutUsd));
  assert.equal(supervisor.sessionSettledPnlUsd, sessionBefore);
  assert.ok(removedPending.includes('btc-updown-5m-1'));
  assert.equal(
    supervisor.settlements.byRound.get('btc-updown-5m-1').winner,
    'UP'
  );
  // Settled rounds must not re-enter the pending capture queue.
  supervisor.pendingCaptureByRound.set('btc-updown-5m-1', runner);
  const upserts = [];
  const prevPending = supervisor.pendingSettlements;
  supervisor.pendingSettlements = {
    ...prevPending,
    upsert(snapshot) {
      upserts.push(snapshot.roundSlug);
    },
  };
  // Drive the same early-return used by #schedulePendingCapture.
  if (!supervisor.settlements.has(runner.roundSlug)) {
    supervisor.pendingSettlements.upsert({ roundSlug: runner.roundSlug });
  }
  assert.deepEqual(upserts, []);

  supervisor.autoBalanceInFlight = true;
  await assert.rejects(() => supervisor.autoBalance(), /already in progress/);
  supervisor.autoBalanceInFlight = false;
});

test('autoBalance cancelEverything blocks late maker fills after profit lock', async () => {
  const { LegBook, MarketBook } = await import('../src/book.js');
  const { RoundRunner, RoundState } = await import('../src/roundRunner.js');
  const { SettlementLedger } = await import('../src/live/settlementLedger.js');
  const { PaperExchange } = await import('../src/exchange/paperExchange.js');

  const paper = new PaperExchange({
    placeLatencyMs: 0,
    cancelLatencyMs: 300,
    queueAheadFactor: 0,
    takerFeeRate: 0,
    feeBps: 0,
  });
  paper.setMarket({
    roundSlug: 'btc-updown-5m-race',
    tokenIds: { UP: 'tok-up', DOWN: 'tok-down' },
  });
  paper.setClock(1_000);

  const runner = new RoundRunner({
    roundSlug: 'btc-updown-5m-race',
    windowStartEpoch: 1,
    tokenIds: { UP: 'tok-up', DOWN: 'tok-down' },
    exchange: paper,
    logger: quiet,
    recorder: { record() {}, async recordSettlement() {} },
  });
  runner.inventory.addFill('UP', 400, 10, 1);
  runner.inventory.addFill('DOWN', 500, 5, 1);
  runner.state = RoundState.QUOTING;
  runner.feeUsd = 0;

  const placed = await paper.placeLimitBuy({
    tokenId: 'tok-up',
    price: 0.58,
    size: 10,
    roundSlug: 'btc-updown-5m-race',
    offsetTicks: 1,
  });
  runner.orders.orderLedger.set(placed.orderId, {
    orderId: placed.orderId,
    roundId: 'btc-updown-5m-race',
    leg: 'UP',
    side: 'BUY',
    mils: 580,
    price: 0.58,
    avgFillMils: null,
    originalShares: 10,
    filledShares: 0,
    remainingShares: 10,
    status: 'resting',
    replenish: false,
    protection: false,
    orderType: 'GTC',
    role: null,
    feeUsd: 0,
    placedAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });
  runner.orders.live.set('UP@580', {
    orderId: placed.orderId,
    leg: 'UP',
    mils: 580,
    restingShares: 10,
    placedAtMs: Date.now(),
  });

  const supervisor = Object.create(Supervisor.prototype);
  supervisor.autoBalanceInFlight = false;
  supervisor.halted = false;
  supervisor.haltReason = null;
  supervisor.logger = quiet;
  supervisor.pausedRound = null;
  supervisor.pauseReason = null;
  supervisor.currentMarket = {
    roundSlug: 'btc-updown-5m-race',
    tokenIds: { UP: 'tok-up', DOWN: 'tok-down' },
  };
  const downBook = new LegBook(
    [{ price: 0.51, size: 100 }],
    [{ price: 0.52, size: 100 }],
    10
  );
  const upBook = new LegBook(
    [{ price: 0.58, size: 50 }],
    [{ price: 0.59, size: 50 }],
    10
  );
  supervisor.lastBooks = { UP: upBook, DOWN: downBook };
  supervisor.adapter = paper;
  supervisor.settlements = new SettlementLedger();
  supervisor.sessionSettledPnlUsd = 0;
  supervisor.settlementPersistenceEnabled = false;
  supervisor.pendingSettlements = {
    remove() {},
    get() {
      return null;
    },
  };
  supervisor.pendingCaptureByRound = new Map();
  supervisor.accountingUncertainRounds = new Set();
  supervisor.settlingRounds = new Set();
  supervisor.recorder = { record() {}, async recordSettlement() {} };
  supervisor.marketClock = { nowEpochSeconds: () => 100 };
  supervisor.engine = {
    current: runner,
    settledRounds: new Set(),
    history: [],
    pending: new Map(),
    onFill(fill) {
      runner.onFill(fill);
      return runner;
    },
  };
  paper.setFillHandler((fill) => {
    if (fill?.roundSlug && supervisor.settlements.has(fill.roundSlug)) return;
    if (runner.state === RoundState.DONE) return;
    runner.onFill({
      leg: fill.leg,
      price: fill.price,
      size: fill.size,
      fee: fill.fee ?? 0,
      ts: fill.ts,
      orderId: fill.orderId,
      role: fill.role,
      full: fill.full,
      roundSlug: fill.roundSlug,
    });
  });

  assert.equal(paper.open.size, 1);
  const result = await supervisor.autoBalance();
  assert.equal(result.ok, true);
  assert.equal(runner.inventory.tiltShares(), 0);
  assert.equal(paper.open.size, 0, 'cancelEverything must clear resting makers');

  // Book shrink that would have filled the cancelled maker during cancel latency.
  const shrinkUp = new LegBook(
    [{ price: 0.58, size: 5 }],
    [{ price: 0.59, size: 50 }],
    20
  );
  paper.onMarketBook(
    new MarketBook(shrinkUp, downBook),
    2,
    'btc-updown-5m-race',
    { protectionOnly: true }
  );
  paper.onMarketBook(
    new MarketBook(shrinkUp, downBook),
    2,
    'btc-updown-5m-race',
    { protectionOnly: false }
  );

  assert.equal(runner.inventory.tiltShares(), 0);
  assert.equal(runner.inventory.shares('UP'), 10);
  assert.equal(runner.inventory.shares('DOWN'), 10);
  const tracked = runner.orders.orderLedger.get(placed.orderId);
  assert.equal(tracked.status, 'cancelled');
  assert.equal(tracked.filledShares, 0);
});

test('Supervisor.autoBalance fails without locking when ask depth cannot flatten', async () => {
  const { LegBook } = await import('../src/book.js');
  const { RoundRunner, RoundState } = await import('../src/roundRunner.js');
  const { SettlementLedger } = await import('../src/live/settlementLedger.js');
  const { PaperExchange } = await import('../src/exchange/paperExchange.js');

  const paper = new PaperExchange({
    placeLatencyMs: 0,
    takerFeeRate: 0,
    feeBps: 0,
  });
  paper.setMarket({
    roundSlug: 'btc-updown-5m-2',
    tokenIds: { UP: 'u', DOWN: 'd' },
  });
  const runner = new RoundRunner({
    roundSlug: 'btc-updown-5m-2',
    windowStartEpoch: 1,
    tokenIds: { UP: 'u', DOWN: 'd' },
    exchange: paper,
    logger: quiet,
    recorder: { record() {}, async recordSettlement() {} },
  });
  runner.inventory.addFill('UP', 400, 20, 1);
  runner.state = RoundState.QUOTING;
  paper.setFillHandler((fill) => {
    runner.onFill({
      leg: fill.leg,
      price: fill.price,
      size: fill.size,
      fee: fill.fee ?? 0,
      ts: fill.ts,
      orderId: fill.orderId,
      role: fill.role,
    });
  });

  const thinDown = new LegBook(
    [{ price: 0.51, size: 10 }],
    [{ price: 0.52, size: 1 }], // only 1 share available each attempt
    10
  );
  const supervisor = Object.create(Supervisor.prototype);
  supervisor.autoBalanceInFlight = false;
  supervisor.halted = false;
  supervisor.logger = quiet;
  supervisor.pausedRound = null;
  supervisor.pauseReason = null;
  supervisor.currentMarket = {
    roundSlug: 'btc-updown-5m-2',
    tokenIds: { UP: 'u', DOWN: 'd' },
  };
  supervisor.lastBooks = { UP: thinDown, DOWN: thinDown };
  supervisor.adapter = paper;
  supervisor.settlements = new SettlementLedger();
  supervisor.sessionSettledPnlUsd = 0;
  supervisor.settlementPersistenceEnabled = false;
  supervisor.pendingSettlements = { remove() {} };
  supervisor.pendingCaptureByRound = new Map();
  supervisor.marketClock = { nowEpochSeconds: () => 100 };
  supervisor.engine = {
    current: runner,
    settledRounds: new Set(),
    history: [],
    pending: new Map(),
  };

  const result = await supervisor.autoBalance();
  assert.equal(result.ok, false);
  assert.match(result.error, /hedge incomplete/);
  assert.ok(Math.abs(result.tiltAfter) >= 0.01);
  assert.equal(supervisor.settlements.has('btc-updown-5m-2'), false);
  assert.equal(supervisor.pausedRound, 'btc-updown-5m-2');
});

test('Supervisor.autoBalance refuses an uneconomic complementary hedge', async () => {
  const { LegBook } = await import('../src/book.js');
  const { RoundRunner, RoundState } = await import('../src/roundRunner.js');
  const { PaperExchange } = await import('../src/exchange/paperExchange.js');

  const paper = new PaperExchange({
    placeLatencyMs: 0,
    takerFeeRate: 0.07,
    feeBps: 0,
  });
  paper.setMarket({
    roundSlug: 'btc-updown-5m-uneconomic',
    tokenIds: { UP: 'u', DOWN: 'd' },
  });
  const runner = new RoundRunner({
    roundSlug: 'btc-updown-5m-uneconomic',
    windowStartEpoch: 1,
    tokenIds: { UP: 'u', DOWN: 'd' },
    exchange: paper,
    logger: quiet,
    recorder: { record() {}, async recordSettlement() {} },
  });
  runner.inventory.addFill('UP', 478, 10, 1);
  runner.state = RoundState.QUOTING;

  const supervisor = Object.create(Supervisor.prototype);
  supervisor.autoBalanceInFlight = false;
  supervisor.halted = false;
  supervisor.logger = quiet;
  supervisor.pausedRound = null;
  supervisor.pauseReason = null;
  supervisor.params = { ...P, POLYMARKET_TAKER_FEE_RATE: 0.07 };
  supervisor.currentMarket = {
    roundSlug: runner.roundSlug,
    tokenIds: runner.tokenIds,
  };
  supervisor.lastBooks = {
    UP: new LegBook(
      [{ price: 0.47, size: 100 }],
      [{ price: 0.48, size: 100 }],
      10
    ),
    DOWN: new LegBook(
      [{ price: 0.58, size: 100 }],
      [{ price: 0.589, size: 100 }],
      10
    ),
  };
  supervisor.adapter = paper;
  supervisor.recorder = { record() {} };
  supervisor.settlements = { has: () => false };
  supervisor.engine = { current: runner };

  const result = await supervisor.autoBalance();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'hedge_not_economic');
  assert.equal(result.pauseReason, 'hedge_not_economic');
  assert.equal(result.bestAskMils, 589);
  assert.ok(result.economicCapMils < result.bestAskMils);
  assert.equal(runner.inventory.shares('DOWN'), 0);
  assert.equal(runner.state, RoundState.QUOTING);
  assert.equal(supervisor.pausedRound, runner.roundSlug);
});

test('Auto Balance does not call flat-but-negative inventory profit protection', async () => {
  const { RoundRunner, RoundState } = await import('../src/roundRunner.js');
  const { PaperExchange } = await import('../src/exchange/paperExchange.js');
  const paper = new PaperExchange({ placeLatencyMs: 0, feeBps: 0 });
  paper.setMarket({
    roundSlug: 'btc-updown-5m-flat-loss',
    tokenIds: { UP: 'u', DOWN: 'd' },
  });
  const runner = new RoundRunner({
    roundSlug: 'btc-updown-5m-flat-loss',
    windowStartEpoch: 1,
    tokenIds: { UP: 'u', DOWN: 'd' },
    exchange: paper,
    logger: quiet,
    recorder: { record() {}, async recordSettlement() {} },
  });
  runner.inventory.addFill('UP', 478, 10, 1);
  runner.inventory.addFill('DOWN', 589, 10, 2);
  runner.state = RoundState.QUOTING;

  const supervisor = Object.create(Supervisor.prototype);
  Object.assign(supervisor, {
    autoBalanceInFlight: false,
    halted: false,
    logger: quiet,
    pausedRound: null,
    pauseReason: null,
    params: P,
    currentMarket: {
      roundSlug: runner.roundSlug,
      tokenIds: runner.tokenIds,
    },
    adapter: paper,
    recorder: { record() {} },
    settlements: { has: () => false },
    engine: { current: runner },
  });

  const result = await supervisor.autoBalance();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'hedge_not_economic');
  assert.equal(result.tiltAfter, 0);
  assert.equal(result.worstCasePnlUsd, -0.67);
  assert.equal(runner.state, RoundState.QUOTING);
});

test('live-style autoBalance confirms CLOB fill, residual retry, no double inventory/PnL', async () => {
  const { LegBook } = await import('../src/book.js');
  const { RoundRunner, RoundState } = await import('../src/roundRunner.js');
  const { SettlementLedger } = await import('../src/live/settlementLedger.js');

  const placeSizes = [];
  const fakeLive = {
    mode: 'live',
    async placeLimitBuy({ size }) {
      placeSizes.push(size);
      const filled = placeSizes.length === 1 ? Math.min(6, size) : size;
      return {
        orderId: `live-fak-${placeSizes.length}`,
        filledShares: filled,
        avgPrice: 0.52,
        status: 'matched',
      };
    },
    async cancelOrders() {},
    async cancelEverything() {
      return { cancelled: 0 };
    },
    async redeem() {
      throw new Error('redeem is an on-chain CTF call, not a CLOB method');
    },
  };

  const runner = new RoundRunner({
    roundSlug: 'btc-updown-5m-live',
    windowStartEpoch: 1,
    tokenIds: { UP: 'u', DOWN: 'd' },
    exchange: fakeLive,
    logger: quiet,
    recorder: { record() {}, async recordSettlement() {} },
  });
  runner.inventory.addFill('UP', 400, 20, 1);
  runner.inventory.addFill('DOWN', 500, 10, 1);
  runner.state = RoundState.QUOTING;
  runner.feeUsd = 0;
  assert.equal(runner.inventory.tiltShares(), 10);

  const downBook = new LegBook(
    [{ price: 0.51, size: 100 }],
    [{ price: 0.52, size: 100 }],
    10
  );
  const supervisor = Object.create(Supervisor.prototype);
  supervisor.autoBalanceInFlight = false;
  supervisor.halted = false;
  supervisor.logger = quiet;
  supervisor.pausedRound = null;
  supervisor.pauseReason = null;
  supervisor.params = {
    RUNG_SIZE_STEP_SHARES: 1,
    POLYMARKET_TAKER_FEE_RATE: 0.07,
  };
  supervisor.currentMarket = {
    roundSlug: 'btc-updown-5m-live',
    tokenIds: { UP: 'u', DOWN: 'd' },
  };
  supervisor.lastBooks = {
    UP: new LegBook([{ price: 0.4, size: 50 }], [{ price: 0.41, size: 50 }], 10),
    DOWN: downBook,
  };
  supervisor.adapter = fakeLive;
  supervisor.settlements = new SettlementLedger();
  supervisor.sessionSettledPnlUsd = 0;
  supervisor.settlementPersistenceEnabled = false;
  supervisor.pendingSettlements = { remove() {}, get() { return null; } };
  supervisor.pendingCaptureByRound = new Map();
  supervisor.accountingUncertainRounds = new Set();
  supervisor.recorder = { record() {}, async recordSettlement() {} };
  supervisor.settlingRounds = new Set();
  supervisor.marketClock = { nowEpochSeconds: () => 100 };
  supervisor.engine = {
    current: runner,
    settledRounds: new Set(),
    history: [],
    pending: new Map(),
    async onResolution() {
      throw new Error('must not re-settle via engine');
    },
  };

  const result = await supervisor.autoBalance();
  assert.equal(result.ok, true);
  assert.deepEqual(placeSizes, [10, 4], 'second FAK is residual only');
  assert.equal(runner.inventory.tiltShares(), 0);
  assert.equal(runner.inventory.shares('DOWN'), 20);
  const downAfterLock = runner.inventory.shares('DOWN');

  const { cryptoTakerFeeUsd } = await import('../src/fees.js');
  const fee1 = cryptoTakerFeeUsd(6, 0.52, 0.07);
  const fee2 = cryptoTakerFeeUsd(4, 0.52, 0.07);
  const led1 = runner.orders.orderLedger.get('live-fak-1');
  const led2 = runner.orders.orderLedger.get('live-fak-2');
  assert.equal(led1.role, 'TAKER');
  assert.equal(led1.filledShares, 6);
  assert.equal(led1.feeUsd, fee1);
  assert.equal(led2.role, 'TAKER');
  assert.equal(led2.filledShares, 4);
  assert.equal(led2.feeUsd, fee2);
  assert.equal(runner.feeUsd, Math.round((fee1 + fee2) * 1e5) / 1e5);
  const feeUsdBeforeReplay = runner.feeUsd;

  // User-feed replay of the first FAK must not inflate inventory, ledger, or fees.
  runner.onFill({
    leg: 'DOWN',
    price: 0.52,
    size: 6,
    fee: 99,
    ts: 101,
    orderId: 'live-fak-1',
    role: 'TAKER',
  });
  assert.equal(runner.inventory.shares('DOWN'), downAfterLock);
  assert.equal(led1.filledShares, 6);
  assert.equal(led1.feeUsd, fee1);
  assert.equal(runner.feeUsd, feeUsdBeforeReplay);

  const sessionBefore = supervisor.sessionSettledPnlUsd;
  const resolved = await supervisor.onResolution('btc-updown-5m-live', 'UP');
  assert.equal(resolved.settledBy, 'auto_balance');
  assert.equal(resolved.winner, 'UP');
  assert.equal(resolved.resolvedWinner, 'UP');
  assert.equal(supervisor.sessionSettledPnlUsd, sessionBefore);
  assert.equal(
    supervisor.settlements.byRound.get('btc-updown-5m-live').pnlUsd,
    result.lockedPnlUsd
  );
});

test('LIVE maker markouts are scheduled non-blockingly at every horizon', async () => {
  const { LegBook, MarketBook } = await import('../src/book.js');
  const { RoundRunner } = await import('../src/roundRunner.js');
  const scheduled = [];
  const events = [];
  const exchange = {
    mode: 'live',
    async placeLimitBuy() { return { orderId: 'unused' }; },
    async cancelOrders() {},
  };
  const runner = new RoundRunner({
    roundSlug: 'btc-updown-5m-markout',
    windowStartEpoch: 100,
    tokenIds: { UP: 'u', DOWN: 'd' },
    exchange,
    logger: quiet,
    recorder: { record(event) { events.push(event); } },
    scheduleTimer(callback, horizonMs) {
      scheduled.push({ callback, horizonMs });
      return { unref() {} };
    },
  });
  runner.lastBooks = new MarketBook(
    new LegBook(
      [{ price: 0.49, size: 100 }],
      [{ price: 0.50, size: 100 }],
      101
    ),
    new LegBook(
      [{ price: 0.50, size: 100 }],
      [{ price: 0.51, size: 100 }],
      101
    )
  );

  runner.onFill({
    leg: 'UP',
    price: 0.49,
    size: 5,
    fee: 0,
    ts: 101,
    orderId: 'maker-1',
    role: 'MAKER',
  });
  assert.deepEqual(
    scheduled.map((row) => row.horizonMs),
    [250, 500, 1000, 2000, 5000]
  );

  runner.lastBooks = new MarketBook(
    new LegBook(
      [{ price: 0.47, size: 100 }],
      [{ price: 0.48, size: 100 }],
      102
    ),
    runner.lastBooks.DOWN
  );
  for (const row of scheduled) row.callback();
  const markouts = events.filter((event) => event.type === 'MAKER_MARKOUT');
  assert.equal(markouts.length, 5);
  assert.equal(markouts[0].fill_mils, 490);
  assert.equal(markouts[0].future_best_bid_mils, 470);
  assert.equal(markouts[0].future_mid_mils, 475);
  assert.equal(markouts[0].markout_mils, -15);
  assert.equal(markouts[0].pair_cycle_state, 'WAITING_FOR_COMPLEMENT');
  assert.equal(markouts[0].inventory_state.unmatchedUp, 5);
});

test('order-ledger serialization is throttled independently of the fast clock snapshot', async () => {
  let orderReads = 0;
  const orders = {
    ledgerVersion: 0,
    live: new Map(),
    ordersSnapshot() {
      orderReads += 1;
      return [];
    },
  };
  const supervisor = {
    health: () => ({ ready: true, mode: 'paper', market: [], recorder: {} }),
    engine: {
      current: { roundSlug: 'r', orders },
      history: [],
    },
  };
  const status = new StatusServer({
    supervisor,
    port: 0,
    host: '127.0.0.1',
    snapshotMs: 250,
    ordersSnapshotMs: 750,
    logger: quiet,
  });
  const server = status.start();
  await new Promise((resolve) => server.once('listening', resolve));
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(orderReads, 1, 'unchanged ledger must reuse the cached order list');
  orders.ledgerVersion += 1;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(orderReads, 2, 'changed ledger refreshes at the slower cadence');
  await status.close();
});

test('resubscribing detaches the old socket so it cannot poison the new round', () => {
  const f = new MarketFeed({ logger: quiet });
  const sockets = [];
  // Intercept socket creation by subscribing twice and capturing generations.
  f.subscribe({ UP: 'a1', DOWN: 'b1' }, 'round-1');
  const first = f.socket;
  sockets.push(first);
  f.subscribe({ UP: 'a2', DOWN: 'b2' }, 'round-2');
  const second = f.socket;

  assert.notEqual(first, second);
  assert.equal(first.listenerCount('close'), 0, 'old socket must have no listeners left');
  assert.equal(f.generation, 2);

  // Even if something re-emits on the stale socket, generation guards it.
  let resyncs = 0;
  f.on('resync', () => { resyncs += 1; });
  first.emit('close');
  assert.equal(resyncs, 0, 'a stale socket must not trigger resync on the new round');
  f.close();
});

test('book resync reconnect keeps a referenced timer so the process cannot drain', () => {
  const f = new MarketFeed({ logger: quiet });
  f.subscribe({ UP: 'a1', DOWN: 'b1' }, 'round-1');
  const sock = f.socket;
  sock.reconnect();
  assert.ok(
    sock.reconnectTimer,
    'resync reconnect must arm a ref’d timer while the websocket is down'
  );
  f.close();
  assert.equal(sock.reconnectTimer, null);
});

test('resync waits for both token snapshots before declaring recovery', () => {
  const f = new MarketFeed({ logger: quiet });
  let resyncs = 0;
  const books = [];
  f.on('resync', () => { resyncs += 1; });
  f.on('book', (book) => books.push(book));
  f.subscribe({ UP: 'up-token', DOWN: 'down-token' }, 'round-1');

  f.socket.emit('close');
  assert.equal(f.resyncPending, true);
  assert.equal(resyncs, 1);
  f.socket.emit('message', {
    event_type: 'book',
    asset_id: 'up-token',
    bids: [{ price: 0.5, size: 100 }],
    asks: [{ price: 0.51, size: 100 }],
  });
  assert.equal(resyncs, 1, 'first leg must not start another reconnect');
  assert.equal(f.resyncPending, true);
  f.socket.emit('message', {
    event_type: 'book',
    asset_id: 'down-token',
    bids: [{ price: 0.49, size: 100 }],
    asks: [{ price: 0.5, size: 100 }],
  });
  assert.equal(resyncs, 1);
  assert.equal(f.resyncPending, false);
  assert.equal(books.length, 1, 'publish only after both snapshots are valid');
  f.close();
});

test('market feed routes batched price changes by each token asset id', () => {
  const f = new MarketFeed({ logger: quiet });
  const published = [];
  f.on('book', (book) => published.push(book));
  f.subscribe({ UP: 'up-token', DOWN: 'down-token' }, 'round-1');
  f.socket.emit('message', {
    event_type: 'book',
    asset_id: 'up-token',
    bids: [{ price: 0.5, size: 100 }],
    asks: [{ price: 0.51, size: 100 }],
  });
  f.socket.emit('message', {
    event_type: 'book',
    asset_id: 'down-token',
    bids: [{ price: 0.49, size: 100 }],
    asks: [{ price: 0.5, size: 100 }],
  });
  f.socket.emit('message', {
    event_type: 'price_change',
    market: 'condition-id-not-a-token',
    price_changes: [
      { asset_id: 'up-token', price: 0.5, size: 0, side: 'BUY' },
      { asset_id: 'up-token', price: 0.49, size: 80, side: 'BUY' },
      { asset_id: 'down-token', price: 0.49, size: 0, side: 'BUY' },
      { asset_id: 'down-token', price: 0.48, size: 90, side: 'BUY' },
    ],
  });
  const latest = published.at(-1);
  assert.equal(latest.UP.bestBid, 490);
  assert.equal(latest.DOWN.bestBid, 480);
  assert.deepEqual(
    f.health().map((x) => x.deltas),
    [1, 1]
  );
  f.close();
});

test('user feed health is driven by the socket, not asserted at subscribe', () => {
  const u = new UserFeed({ apiCreds: { key: 'k', secret: 's', passphrase: 'p' }, logger: quiet });
  const seen = [];
  u.on('connected', () => seen.push('connected'));
  u.on('disconnected', () => seen.push('disconnected'));
  u.subscribe(['0xcond1']);
  const first = u.socket;
  u.subscribe(['0xcond2']);          // rollover
  first.emit('close');               // stale socket closes late
  assert.deepEqual(seen, [], 'a stale close must not report the live feed as down');
  u.socket.emit('open');
  assert.deepEqual(seen, ['connected']);
  u.close();
});

test('user feed keeps venue role, fee, status, transaction, and match time', () => {
  const u = new UserFeed({
    apiCreds: { key: 'k', secret: 's', passphrase: 'p' },
    logger: quiet,
  });
  const fills = [];
  u.setRoundAssets(
    { UP: 'up-token', DOWN: 'down-token' },
    'btc-updown-5m-1785231600'
  );
  u.on('fill', (fill) => fills.push(fill));
  u.subscribe(['0xcond']);
  u.socket.emit('message', {
    payload: {
      event_type: 'trade',
      id: 'trade-1',
      asset_id: 'up-token',
      side: 'BUY',
      price: '0.4',
      size: '10',
      trader_side: 'TAKER',
      fee_rate_bps: '700',
      status: 'MATCHED',
      transaction_hash: '0xabc',
      matchtime: '2026-07-28T09:21:06.161Z',
      taker_order_id: 'order-1',
    },
  });

  assert.equal(fills.length, 1);
  assert.equal(fills[0].leg, 'UP');
  assert.equal(fills[0].roundSlug, 'btc-updown-5m-1785231600');
  assert.equal(fills[0].role, 'TAKER');
  assert.equal(fills[0].fee, 0.168);
  assert.equal(fills[0].status, 'MATCHED');
  assert.equal(fills[0].transactionHash, '0xabc');
  assert.equal(fills[0].ts, Date.parse('2026-07-28T09:21:06.161Z') / 1000);
  u.close();
});

test('user feed attributes camelCase makerOrders to this account exactly', () => {
  const u = new UserFeed({
    apiCreds: { key: 'k', secret: 's', passphrase: 'p' },
    logger: quiet,
  });
  const fills = [];
  const unexpectedSells = [];
  u.setRoundAssets(
    { UP: 'up-token', DOWN: 'down-token' },
    'btc-updown-5m-1785231600'
  );
  u.setOrderLookup((id) => id === 'our-order-2');
  u.on('fill', (fill) => fills.push(fill));
  u.on('unexpected_sell', (event) => unexpectedSells.push(event));
  u.subscribe(['0xcond']);
  const event = {
    topic: 'user',
    payload: {
      eventType: 'trade',
      id: 'trade-camel-1',
      tokenId: 'up-token',
      side: 'SELL',
      price: '0.42',
      size: '100',
      status: 'TRADE_STATUS_MATCHED',
      matchTime: '2026-07-28T09:21:06.161Z',
      feeUsd: '999',
      makerOrders: [
        {
          orderId: 'other-order',
          owner: 'other-api-key',
          tokenId: 'up-token',
          side: 'BUY',
          price: '0.41',
          matchedAmount: '50',
          feeRateBps: '0',
        },
        {
          orderId: 'our-order-1',
          owner: 'k',
          tokenId: 'up-token',
          side: 'BUY',
          price: '0.40',
          matchedAmount: '2.5',
          feeRateBps: '0',
        },
        {
          orderId: 'our-order-2',
          owner: 'hidden',
          tokenId: 'up-token',
          side: 'BUY',
          price: '0.39',
          matchedAmount: '1.25',
          feeRateBps: '0',
        },
      ],
    },
  };
  u.socket.emit('message', event);
  // A later MINED/CONFIRMED update for the same trade must not count again.
  event.payload.status = 'TRADE_STATUS_CONFIRMED';
  u.socket.emit('message', event);

  assert.equal(fills.length, 2);
  assert.deepEqual(
    fills.map((fill) => ({
      orderId: fill.orderId,
      leg: fill.leg,
      price: fill.price,
      size: fill.size,
      role: fill.role,
    })),
    [
      {
        orderId: 'our-order-1',
        leg: 'UP',
        price: 0.4,
        size: 2.5,
        role: 'MAKER',
      },
      {
        orderId: 'our-order-2',
        leg: 'UP',
        price: 0.39,
        size: 1.25,
        role: 'MAKER',
      },
    ]
  );
  assert.equal(unexpectedSells.length, 0);
  assert.ok(fills.every((fill) => fill.fee === 0));
  assert.equal(
    fills[0].ts,
    Date.parse('2026-07-28T09:21:06.161Z') / 1000
  );
  u.close();
});

test('user feed rejects an unattributable multi-maker trade', () => {
  const u = new UserFeed({
    apiCreds: { key: 'k', secret: 's', passphrase: 'p' },
    logger: quiet,
  });
  const fills = [];
  const ambiguous = [];
  u.setRoundAssets(
    { UP: 'up-token', DOWN: 'down-token' },
    'btc-updown-5m-1785231600'
  );
  u.on('fill', (fill) => fills.push(fill));
  u.on('ambiguous_fill', (event) => ambiguous.push(event));
  u.subscribe(['0xcond']);
  u.socket.emit('message', {
    type: 'trade',
    payload: {
      id: 'ambiguous-trade',
      traderSide: 'MAKER',
      makerOrders: [
        {
          orderId: 'unknown-1',
          owner: 'unknown-1',
          tokenId: 'up-token',
          side: 'BUY',
          price: '0.40',
          matchedAmount: '2',
        },
        {
          orderId: 'unknown-2',
          owner: 'unknown-2',
          tokenId: 'up-token',
          side: 'BUY',
          price: '0.39',
          matchedAmount: '3',
        },
      ],
    },
  });
  assert.equal(fills.length, 0);
  assert.equal(ambiguous.length, 1);
  u.close();
});

test('user feed never books FAILED and flags a booked trade that later fails', () => {
  const u = new UserFeed({
    apiCreds: { key: 'k', secret: 's', passphrase: 'p' },
    logger: quiet,
  });
  const fills = [];
  const failures = [];
  u.setRoundAssets(
    { UP: 'up-token', DOWN: 'down-token' },
    'btc-updown-5m-1785231600'
  );
  u.on('fill', (fill) => fills.push(fill));
  u.on('fill_failed', (event) => failures.push(event));
  u.subscribe(['0xcond']);
  const payload = {
    event_type: 'trade',
    asset_id: 'up-token',
    side: 'BUY',
    price: '0.4',
    size: '10',
    trader_side: 'TAKER',
    fee_rate_bps: '700',
  };

  u.socket.emit('message', {
    ...payload,
    id: 'failed-before-booking',
    status: 'TRADE_STATUS_FAILED',
  });
  assert.equal(fills.length, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].wasBooked, false);

  u.socket.emit('message', {
    ...payload,
    id: 'failed-after-match',
    status: 'MATCHED',
  });
  u.socket.emit('message', {
    ...payload,
    id: 'failed-after-match',
    status: 'FAILED',
  });
  // Repeated lifecycle notifications must be idempotent.
  u.socket.emit('message', {
    ...payload,
    id: 'failed-after-match',
    status: 'FAILED',
  });
  assert.equal(fills.length, 1);
  assert.equal(failures.length, 2);
  assert.equal(failures[1].wasBooked, true);
  u.close();
});

test('reconcile is not re-entrant', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let placed = 0;
  const exchange = {
    async placeLimitBuy() {
      placed += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { orderId: `o${Math.random()}` };
    },
    async cancelOrders() {},
  };
  const om = new OrderManager(exchange, {
    roundSlug: 'r', logger: quiet, params: { ...P, MIN_REQUOTE_INTERVAL_MS: 0 },
  });
  const rungs = [
    { leg: 'UP', mils: 490, shares: 90, offsetTicks: 1, key: 'UP@490' },
    { leg: 'DOWN', mils: 490, shares: 90, offsetTicks: 1, key: 'DOWN@490' },
  ];
  const ctx = { roundSlug: 'r', tokenIds: { UP: 'u', DOWN: 'd' } };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => om.reconcile(rungs, ctx, Date.now()))
  );
  assert.ok(
    results.some((r) => r.reason === 'coalesced'),
    'overlapping calls must retain only the newest desired state'
  );
  assert.ok(om.live.size <= P.LADDER_LEVELS * 2, `live orders ${om.live.size} exceeded the cap`);
  assert.ok(maxInFlight <= 2, `expected at most 2 concurrent places, saw ${maxInFlight}`);
  assert.equal(placed, 2, 'coalescing identical updates must not create duplicates');
});

test('reconcile coalesces network-time updates to the latest desired state', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const placed = [];
  const cancelled = [];
  let first = true;
  const exchange = {
    async placeLimitBuy(order) {
      if (first) {
        first = false;
        await gate;
      }
      placed.push(`${order.tokenId}@${Math.round(order.price * 1000)}`);
      return { orderId: `o${placed.length}` };
    },
    async cancelOrders(ids) { cancelled.push(...ids); },
  };
  const om = new OrderManager(exchange, {
    roundSlug: 'r', logger: quiet, params: { ...P, MIN_REQUOTE_INTERVAL_MS: 0 },
  });
  const ctx = { roundSlug: 'r', tokenIds: { UP: 'u', DOWN: 'd' } };
  const firstRun = om.reconcile(
    [{ leg: 'UP', mils: 490, shares: 10, offsetTicks: 1, key: 'UP@490' }],
    ctx,
    1
  );
  await Promise.resolve();
  await om.reconcile(
    [{ leg: 'DOWN', mils: 480, shares: 10, offsetTicks: 1, key: 'DOWN@480' }],
    ctx,
    2
  );
  await om.reconcile(
    [{ leg: 'DOWN', mils: 470, shares: 10, offsetTicks: 1, key: 'DOWN@470' }],
    ctx,
    3
  );
  release();
  const result = await firstRun;

  assert.deepEqual(placed, ['u@490', 'd@470']);
  assert.deepEqual(cancelled, ['o1']);
  assert.equal(result.coalescedProcessed, 1);
  assert.deepEqual([...om.live.keys()], ['DOWN@470']);
});

test('cancelAll drains an in-flight placement before rollover', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cancelled = [];
  const exchange = {
    async placeLimitBuy() {
      await gate;
      return { orderId: 'old-round-order' };
    },
    async cancelOrders(ids) { cancelled.push(...ids); },
  };
  const om = new OrderManager(exchange, {
    roundSlug: 'old-round', logger: quiet, params: { ...P, MIN_REQUOTE_INTERVAL_MS: 0 },
  });
  const reconcile = om.reconcile(
    [{ leg: 'UP', mils: 490, shares: 25, offsetTicks: 1, key: 'UP@490' }],
    { roundSlug: 'old-round', tokenIds: { UP: 'old-up', DOWN: 'old-down' } },
    1
  );
  const cancel = om.cancelAll();
  release();
  await Promise.all([reconcile, cancel]);
  assert.deepEqual(cancelled, ['old-round-order']);
  assert.equal(om.live.size, 0);
});

test('live order count never exceeds LADDER_LEVELS * 2 across repeated reconciles', async () => {
  const exchange = {
    async placeLimitBuy() { return { orderId: `o${Math.random()}` }; },
    async cancelOrders() {},
  };
  const om = new OrderManager(exchange, {
    roundSlug: 'r', logger: quiet, params: { ...P, MIN_REQUOTE_INTERVAL_MS: 0 },
  });
  const ctx = { roundSlug: 'r', tokenIds: { UP: 'u', DOWN: 'd' } };
  for (let bid = 500; bid > 400; bid -= 10) {
    const rungs = [
      { leg: 'UP', mils: bid - 10, shares: 90, offsetTicks: 1, key: `UP@${bid - 10}` },
      { leg: 'UP', mils: bid - 20, shares: 90, offsetTicks: 2, key: `UP@${bid - 20}` },
      { leg: 'DOWN', mils: bid - 10, shares: 90, offsetTicks: 1, key: `DOWN@${bid - 10}` },
      { leg: 'DOWN', mils: bid - 20, shares: 90, offsetTicks: 2, key: `DOWN@${bid - 20}` },
    ];
    // eslint-disable-next-line no-await-in-loop
    await om.reconcile(rungs, ctx, Date.now());
  }
  assert.equal(om.live.size, 4, `walked the book and ended with ${om.live.size} live orders`);
  assert.equal(om.stats.invariantBreaches ?? 0, 0);
});

test('order ledger retains resting, partial, filled, and cancelled lifecycle states', async () => {
  let seq = 0;
  const exchange = {
    async placeLimitBuy() { return { orderId: `o${++seq}` }; },
    async cancelOrders() {},
  };
  const om = new OrderManager(exchange, {
    roundSlug: 'round-1', logger: quiet, params: { ...P, MIN_REQUOTE_INTERVAL_MS: 0 },
  });
  const ctx = { roundSlug: 'round-1', tokenIds: { UP: 'u', DOWN: 'd' } };
  await om.reconcile(
    [{ leg: 'UP', mils: 490, shares: 90, offsetTicks: 1, key: 'UP@490' }],
    ctx,
    1
  );
  om.onFill({ leg: 'UP', mils: 490, shares: 30, orderId: 'o1' });
  assert.equal(om.orderLedger.get('o1').status, 'partial');
  assert.equal(om.orderLedger.get('o1').remainingShares, 60);
  om.onFill({ leg: 'UP', mils: 490, shares: 60, orderId: 'o1' });
  assert.equal(om.orderLedger.get('o1').status, 'filled');

  await om.reconcile(
    [{ leg: 'DOWN', mils: 490, shares: 90, offsetTicks: 1, key: 'DOWN@490' }],
    ctx,
    2
  );
  await om.reconcile([], ctx, 3);
  assert.equal(om.orderLedger.get('o2').status, 'cancelled');
  assert.equal(om.ordersSnapshot()[0].roundId, 'round-1');
});

test('replenish deficit below MIN_RUNG_SHARES cancel-replaces full size', async () => {
  const placed = [];
  const cancelled = [];
  let seq = 0;
  const exchange = {
    async placeLimitBuy({ size }) {
      seq += 1;
      const orderId = `o${seq}`;
      placed.push({ orderId, size });
      return { orderId };
    },
    async cancelOrders(ids) {
      cancelled.push(...ids);
    },
  };
  const om = new OrderManager(exchange, {
    roundSlug: 'round-min',
    logger: quiet,
    params: {
      ...P,
      MIN_REQUOTE_INTERVAL_MS: 0,
      MIN_RUNG_SHARES: 5,
      REPLENISH_PARTIAL_RUNGS: true,
    },
  });
  const ctx = { roundSlug: 'round-min', tokenIds: { UP: 'u', DOWN: 'd' } };
  const rung = {
    leg: 'UP',
    mils: 490,
    shares: 10,
    offsetTicks: 1,
    key: 'UP@490',
  };

  await om.reconcile([rung], ctx, 1);
  assert.equal(placed[0].size, 10);

  // Leave resting 7 → deficit 3 (< 5): must cancel+replace 10, not place 3.
  om.onFill({ leg: 'UP', mils: 490, shares: 3, orderId: 'o1' });
  assert.equal(om.live.get('UP@490').restingShares, 7);

  await om.reconcile([rung], ctx, 2);
  assert.deepEqual(cancelled, ['o1']);
  assert.equal(placed[1].size, 10);
  assert.ok(
    placed.every((p) => p.size >= 5),
    'never place below venue min'
  );
  assert.equal(om.live.get('UP@490').restingShares, 10);
});

test('replenish deficit at or above MIN_RUNG_SHARES tops up by deficit only', async () => {
  const placed = [];
  let seq = 0;
  const exchange = {
    async placeLimitBuy({ size }) {
      seq += 1;
      const orderId = `o${seq}`;
      placed.push({ orderId, size });
      return { orderId };
    },
    async cancelOrders() {},
  };
  const om = new OrderManager(exchange, {
    roundSlug: 'round-topup',
    logger: quiet,
    params: {
      ...P,
      MIN_REQUOTE_INTERVAL_MS: 0,
      MIN_RUNG_SHARES: 5,
      REPLENISH_PARTIAL_RUNGS: true,
    },
  });
  const ctx = { roundSlug: 'round-topup', tokenIds: { UP: 'u', DOWN: 'd' } };
  const rung = {
    leg: 'UP',
    mils: 490,
    shares: 10,
    offsetTicks: 1,
    key: 'UP@490',
  };

  await om.reconcile([rung], ctx, 1);
  om.onFill({ leg: 'UP', mils: 490, shares: 5, orderId: 'o1' });
  await om.reconcile([rung], ctx, 2);
  assert.equal(placed[1].size, 5);
  assert.equal(om.live.get('UP@490').restingShares, 10);
});

test('REPLENISH_AHEAD_LEG=false blocks a partial-rung top-up after a fill', async () => {
  const placed = [];
  const exchange = {
    async placeLimitBuy(order) {
      placed.push(order);
      return { orderId: `o${placed.length}` };
    },
    async cancelOrders() {},
  };
  const om = new OrderManager(exchange, {
    roundSlug: 'r',
    logger: quiet,
    params: {
      ...P,
      MIN_REQUOTE_INTERVAL_MS: 0,
      REPLENISH_PARTIAL_RUNGS: true,
      REPLENISH_AHEAD_LEG: false,
    },
  });
  const desired = [
    { leg: 'UP', mils: 490, shares: 10, offsetTicks: 1, key: 'UP@490' },
  ];
  const ctx = { roundSlug: 'r', tokenIds: { UP: 'u', DOWN: 'd' } };
  await om.reconcile(desired, ctx, 1);
  om.onFill({ leg: 'UP', mils: 490, shares: 5, orderId: 'o1' });
  om.setAheadLeg('UP');
  await om.reconcile(desired, ctx, 2);

  assert.equal(placed.length, 1);
  assert.equal(om.live.get('UP@490').restingShares, 5);
  assert.equal(om.stats.aheadPlacementsSuppressed, 1);
});

test('order ledger books EXE role and fee once from fills', async () => {
  let seq = 0;
  const exchange = {
    async placeLimitBuy() {
      seq += 1;
      return { orderId: `o${seq}` };
    },
    async cancelOrders() {},
  };
  const om = new OrderManager(exchange, {
    roundSlug: 'round-exe',
    logger: quiet,
    params: { ...P, MIN_REQUOTE_INTERVAL_MS: 0 },
  });
  const ctx = { roundSlug: 'round-exe', tokenIds: { UP: 'u', DOWN: 'd' } };
  await om.reconcile(
    [{ leg: 'UP', mils: 490, shares: 90, offsetTicks: 1, key: 'UP@490' }],
    ctx,
    1
  );
  await om.reconcile(
    [{ leg: 'DOWN', mils: 480, shares: 10, offsetTicks: 1, key: 'DOWN@480' }],
    ctx,
    2
  );

  const maker = om.orderLedger.get('o1');
  assert.equal(maker.role, null);
  assert.equal(maker.feeUsd, 0);
  om.onFill({
    leg: 'UP',
    mils: 490,
    shares: 90,
    orderId: 'o1',
    role: 'MAKER',
    fee: 0,
  });
  assert.equal(maker.role, 'MAKER');
  assert.equal(maker.feeUsd, 0);
  om.onFill({
    leg: 'UP',
    mils: 490,
    shares: 1,
    orderId: 'o1',
    role: 'TAKER',
    fee: 9,
  });
  assert.equal(maker.role, 'MAKER', 'role does not flip-flop');
  assert.equal(maker.feeUsd, 0, 'no fee after shares already full');

  const { cryptoTakerFeeUsd } = await import('../src/fees.js');
  const fee = cryptoTakerFeeUsd(10, 0.48, 0.07);
  om.onFill({
    leg: 'DOWN',
    mils: 480,
    shares: 10,
    orderId: 'o2',
    role: 'TAKER',
    fee,
  });
  const taker = om.orderLedger.get('o2');
  assert.equal(taker.role, 'TAKER');
  assert.equal(taker.feeUsd, fee);
  assert.equal(taker.status, 'filled');
});

test('protection FAK ledger keeps limit mils and tracks fill VWAP', async () => {
  const exchange = {
    async placeLimitBuy() {
      return { orderId: 'fak-hedge-1' };
    },
    async cancelOrders() {},
  };
  const om = new OrderManager(exchange, {
    roundSlug: 'round-vwap',
    logger: quiet,
    params: { ...P, MIN_REQUOTE_INTERVAL_MS: 0 },
  });
  await om.placeProtectionFak({
    leg: 'UP',
    mils: 990,
    shares: 17.83,
    tokenId: 'u',
  });
  const led = om.orderLedger.get('fak-hedge-1');
  assert.equal(led.mils, 990);
  assert.equal(led.avgFillMils, null);
  assert.equal(led.filledShares, 0);

  om.onFill({
    leg: 'UP',
    mils: 290,
    shares: 12.6,
    orderId: 'fak-hedge-1',
    role: 'TAKER',
    fee: 0.18,
  });
  assert.equal(led.mils, 990, 'limit mils unchanged');
  assert.equal(led.avgFillMils, 290);
  assert.equal(led.price, 0.29);
  assert.equal(led.status, 'partial');

  om.onFill({
    leg: 'UP',
    mils: 300,
    shares: 5.23,
    orderId: 'fak-hedge-1',
    role: 'TAKER',
    fee: 0.08,
  });
  const expectedVwap = (290 * 12.6 + 300 * 5.23) / 17.83;
  assert.equal(led.mils, 990);
  assert.ok(Math.abs(led.avgFillMils - expectedVwap) < 1e-9);
  assert.ok(Math.abs(led.price - expectedVwap / 1000) < 1e-12);
  assert.equal(led.status, 'filled');

  const snap = om.ordersSnapshot().find((o) => o.orderId === 'fak-hedge-1');
  assert.ok(snap);
  assert.equal(snap.mils, 990);
  assert.ok(Math.abs(snap.avgFillMils - expectedVwap) < 1e-9);
});

test('concurrent book updates create exactly one RoundRunner per window', async () => {
  const { Engine } = await import('../src/engine.js');
  const { LegBook: LB, MarketBook: MB } = await import('../src/book.js');
  const mk = (b) => {
    const bids = [], asks = [];
    for (let i = 0; i < 6; i++) {
      if (b - i >= 1) bids.push({ price: (b - i) / 100, size: 400 });
      if (b + 1 + i <= 99) asks.push({ price: (b + 1 + i) / 100, size: 400 });
    }
    return new LB(bids, asks, 0);
  };
  let resolves = 0;
  const eng = new Engine({
    exchange: {
      async placeLimitBuy() { return { orderId: 'x' }; },
      async cancelOrders() {},
      async getFeeSchedule() { return { takerBps: 0, makerBps: 0 }; },
    },
    marketResolver: async (ws) => {
      resolves += 1;
      // The resolver is async; the race lives in this await window.
      await new Promise((r) => setTimeout(r, 20));
      return { roundSlug: `btc-updown-5m-${ws}`, tokenIds: { UP: 'u', DOWN: 'd' } };
    },
    logger: quiet,
    params: { ...(await import('../src/config.js')).PARAMS, ASSUMED_FEE_BPS_OF_NOTIONAL: 0 },
  });
  await eng.preflight();

  const ws = 1785174300;
  const books = new MB(mk(50), mk(49));
  // Ten book updates land while the first roll is still awaiting the resolver.
  await Promise.all(Array.from({ length: 10 }, () => eng.onBook(books, ws + 60)));

  assert.equal(resolves, 1, `resolver called ${resolves} times; expected 1`);
  assert.equal(eng.current.roundSlug, `btc-updown-5m-${ws}`);
});

test('explicit rollover creates the runner before the first market snapshot', async () => {
  const { Engine } = await import('../src/engine.js');
  let resolves = 0;
  const eng = new Engine({
    exchange: {
      async placeLimitBuy() { return { orderId: 'x' }; },
      async cancelOrders() {},
      async getFeeSchedule() { return { takerBps: 0, makerBps: 0 }; },
    },
    marketResolver: async () => {
      resolves += 1;
      throw new Error('resolved market should be reused');
    },
    logger: quiet,
    params: { ...P, ASSUMED_FEE_BPS_OF_NOTIONAL: 0 },
  });
  await eng.preflight();
  const ws = 1785229200;
  await eng.rollTo(ws, {
    roundSlug: `btc-updown-5m-${ws}`,
    tokenIds: { UP: 'u', DOWN: 'd' },
  });
  assert.equal(resolves, 0);
  assert.equal(eng.current?.roundSlug, `btc-updown-5m-${ws}`);
  assert.equal(eng.current?.sec, 0);
});

test('authoritative supervisor window prevents stale book time from rolling backward', async () => {
  const { Engine } = await import('../src/engine.js');
  const { LegBook: LB, MarketBook: MB } = await import('../src/book.js');
  let resolves = 0;
  const eng = new Engine({
    exchange: {
      async placeLimitBuy() { return { orderId: 'x' }; },
      async cancelOrders() {},
      async getFeeSchedule() { return { takerBps: 0, makerBps: 0 }; },
    },
    marketResolver: async () => {
      resolves += 1;
      throw new Error('must not resolve a stale book window');
    },
    logger: quiet,
    params: { ...P, ASSUMED_FEE_BPS_OF_NOTIONAL: 0 },
  });
  await eng.preflight();
  const ws = 1785229500;
  await eng.rollTo(ws, {
    roundSlug: `btc-updown-5m-${ws}`,
    tokenIds: { UP: 'u', DOWN: 'd' },
  });
  const leg = (bid) =>
    new LB(
      [{ price: bid, size: 400 }],
      [{ price: bid + 0.01, size: 400 }],
      ws - 1500
    );
  await eng.onBook(new MB(leg(0.5), leg(0.49)), ws + 30, ws);
  assert.equal(resolves, 0);
  assert.equal(eng.current?.windowStartEpoch, ws);
  assert.equal(eng.current?.sec, 30);
});

test('live adapter getConditionalShares divides wei by conditional decimals', async () => {
  const { AssetType, CONDITIONAL_TOKEN_DECIMALS } = await import(
    '@polymarket/clob-client-v2'
  );
  const seen = [];
  const client = {
    async createOrder() { return { signed: true }; },
    async postOrder() { return { orderID: 'x' }; },
    async cancelOrders() {},
    async getOpenOrders() { return []; },
    async updateBalanceAllowance(params) {
      seen.push(['update', params]);
    },
    async getBalanceAllowance(params) {
      seen.push(['get', params]);
      return { balance: String(12.5 * 10 ** CONDITIONAL_TOKEN_DECIMALS) };
    },
  };
  const adapter = new PolymarketLiveAdapter({
    client,
    limiter: new RL({ capacity: 10, refillPerSec: 1000, logger: quiet }),
    logger: quiet,
  });
  const shares = await adapter.getConditionalShares('tok-1');
  assert.equal(shares, 12.5);
  assert.deepEqual(seen[0], [
    'update',
    { asset_type: AssetType.CONDITIONAL, token_id: 'tok-1' },
  ]);
  assert.deepEqual(seen[1], [
    'get',
    { asset_type: AssetType.CONDITIONAL, token_id: 'tok-1' },
  ]);
});

test('OrderManager invariant breach invokes onInvariantBreach', async () => {
  const breaches = [];
  const exchange = {
    async placeLimitBuy() {
      return { orderId: `o${Math.random()}` };
    },
    async cancelOrders() {},
  };
  const om = new OrderManager(exchange, {
    roundSlug: 'r',
    logger: quiet,
    params: { ...P, LADDER_LEVELS: 1, MIN_REQUOTE_INTERVAL_MS: 0 },
    onInvariantBreach: (info) => breaches.push(info),
  });
  // Force more live entries than LADDER_LEVELS*2 without going through cancel.
  om.live.set('UP@100', { orderId: 'a' });
  om.live.set('UP@200', { orderId: 'b' });
  om.live.set('DOWN@100', { orderId: 'c' });
  const result = await om.reconcile(
    [
      { leg: 'UP', mils: 490, shares: 5, offsetTicks: 1, key: 'UP@490' },
      { leg: 'DOWN', mils: 490, shares: 5, offsetTicks: 1, key: 'DOWN@490' },
    ],
    { roundSlug: 'r', tokenIds: { UP: 'u', DOWN: 'd' } },
    Date.now()
  );
  assert.equal(result.invariantBreach, true);
  assert.equal(om.stats.invariantBreaches, 1);
  assert.equal(breaches.length, 1);
  assert.match(breaches[0].reason, /invariant breach/);
});

test('live pending mismatch fatalExits without process exit when exitOnHalt false', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-pending-'));
  const pendingPath = path.join(dir, 'pending-live.json');
  fs.writeFileSync(
    pendingPath,
    JSON.stringify([
      {
        version: 1,
        roundSlug: 'btc-updown-5m-1000',
        windowStartEpoch: 1000,
        windowEndEpoch: 1300,
        conditionId: '0xcond',
        upIndex: 0,
        tokenIds: { UP: 'u', DOWN: 'd' },
        upShares: 10,
        downShares: 5,
        upCostUsd: 4,
        downCostUsd: 2.5,
        feeUsd: 0,
      },
    ])
  );

  const adapter = {
    mode: 'live',
    async cancelEverything() {
      return { cancelled: 0 };
    },
    async getFeeSchedule() {
      return { takerBps: 0, makerBps: 0 };
    },
    async getConditionalShares(tokenId) {
      return tokenId === 'u' ? 10 : 0;
    },
  };
  const supervisor = new Supervisor({
    adapter,
    logger: quiet,
    params: { ...P, ASSUMED_FEE_BPS_OF_NOTIONAL: 0 },
    log: { enabled: false, dir },
    exitOnHalt: false,
  });
  supervisor.resolver.resolve = async () => {
    throw new Error('should not roll after fatal');
  };
  supervisor.marketFeed.subscribe = () => {};

  await supervisor.start();
  assert.equal(supervisor.halted, true);
  assert.match(supervisor.haltReason, /failed account reconciliation/);
  assert.match(supervisor.haltReason, /mismatch/);
  await supervisor.shutdown('test');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('live pending verified watches resolution and settles from snapshot', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-verified-'));
  const pendingPath = path.join(dir, 'pending-live.json');
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 600;
  const roundSlug = `btc-updown-5m-${windowStart}`;
  fs.writeFileSync(
    pendingPath,
    JSON.stringify([
      {
        version: 1,
        roundSlug,
        windowStartEpoch: windowStart,
        windowEndEpoch: windowStart + 300,
        conditionId: '0xverified',
        upIndex: 0,
        tokenIds: { UP: 'u', DOWN: 'd' },
        upShares: 20,
        downShares: 12,
        upCostUsd: 8,
        downCostUsd: 6.6,
        feeUsd: 0.1,
        fillCount: 2,
      },
    ])
  );

  const watched = [];
  const adapter = {
    mode: 'live',
    async cancelEverything() {
      return { cancelled: 0 };
    },
    async getFeeSchedule() {
      return { takerBps: 0, makerBps: 0 };
    },
    async getConditionalShares(tokenId) {
      return tokenId === 'u' ? 20 : 12;
    },
  };
  const supervisor = new Supervisor({
    adapter,
    logger: quiet,
    params: { ...P, ASSUMED_FEE_BPS_OF_NOTIONAL: 0 },
    log: { enabled: false, dir },
    exitOnHalt: false,
    resolutionWatcher: {
      on() {},
      watch(args) {
        watched.push(args);
      },
      stop() {},
    },
  });
  const activeStart = Math.floor(now / P.ROUND_SECONDS) * P.ROUND_SECONDS;
  supervisor.resolver.resolve = async () => ({
    roundSlug: `btc-updown-5m-${activeStart}`,
    conditionId: '0xnew',
    tokenIds: { UP: 'nu', DOWN: 'nd' },
    upIndex: 0,
    downIndex: 1,
  });
  supervisor.resolver.prefetchNext = () => {};
  supervisor.marketFeed.subscribe = () => {};
  const sigintBefore = new Set(process.rawListeners('SIGINT'));
  const sigtermBefore = new Set(process.rawListeners('SIGTERM'));

  try {
    await supervisor.start();
    assert.equal(supervisor.halted, false);
    assert.ok(supervisor.verifiedPendingRounds.has(roundSlug));
    assert.ok(watched.some((w) => w.roundSlug === roundSlug));

    const settled = await supervisor.onResolution(roundSlug, 'UP');
    assert.ok(settled);
    assert.equal(settled.pnlUsd, 5.3);
    assert.equal(supervisor.verifiedPendingRounds.has(roundSlug), false);
    assert.equal(supervisor.settlements.has(roundSlug), true);
  } finally {
    await supervisor.shutdown('test');
    for (const listener of process.rawListeners('SIGINT')) {
      if (!sigintBefore.has(listener)) process.removeListener('SIGINT', listener);
    }
    for (const listener of process.rawListeners('SIGTERM')) {
      if (!sigtermBefore.has(listener)) process.removeListener('SIGTERM', listener);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('paper bankroll equals initial deposit plus settled PnL', async () => {
  const { SettlementLedger } = await import('../src/live/settlementLedger.js');
  const paper = new PaperExchange();
  const supervisor = new Supervisor({
    adapter: paper,
    logger: quiet,
    params: { ...P, ASSUMED_FEE_BPS_OF_NOTIONAL: 0 },
    log: { enabled: false },
    limits: { paperInitialDepositUsd: 500 },
  });

  assert.equal(supervisor.paperInitialDepositUsd, 500);
  supervisor.settlements = new SettlementLedger();
  supervisor.sessionSettledPnlUsd = 0;
  supervisor.marketClock = {
    nowEpochSeconds: () => 1_700_000_300,
    snapshot: () => ({ nowEpochSeconds: 1_700_000_300 }),
  };
  supervisor.currentWindow = 1_700_000_000;
  supervisor.currentMarket = null;
  supervisor.lastBooks = null;
  supervisor.halted = false;
  supervisor.haltReason = null;
  supervisor.pausedRound = null;
  supervisor.pauseReason = null;
  supervisor.rollInProgress = false;
  supervisor.rollTargetWindow = null;
  supervisor.userFeedHealthy = true;
  supervisor.staleBooks = 0;
  supervisor.marketFeed = { health: () => ({}) };
  supervisor.engine = { current: null };
  supervisor.resolver = { slugFor: (w) => `btc-updown-5m-${w}` };

  let health = supervisor.health();
  assert.equal(health.paperInitialDepositUsd, 500);
  assert.equal(health.paperBankrollUsd, 500);
  assert.equal(health.paperBankrollMarkedUsd, 500);

  supervisor.settlements.upsert({
    roundSlug: 'btc-updown-5m-1700000000',
    pnlUsd: -10,
    winner: 'UP',
  });
  health = supervisor.health();
  assert.equal(health.settledPnlUsd, -10);
  assert.equal(health.paperBankrollUsd, 490);

  supervisor.settlements.upsert({
    roundSlug: 'btc-updown-5m-1700000300',
    pnlUsd: 3,
    winner: 'DOWN',
  });
  health = supervisor.health();
  assert.equal(health.settledPnlUsd, -7);
  assert.equal(health.paperBankrollUsd, 493);

  const live = new Supervisor({
    adapter: {
      mode: 'live',
      async cancelEverything() {
        return { cancelled: 0 };
      },
      async getFeeSchedule() {
        return { takerBps: 0, makerBps: 0 };
      },
    },
    logger: quiet,
    params: { ...P, ASSUMED_FEE_BPS_OF_NOTIONAL: 0 },
    log: { enabled: false },
    limits: { paperInitialDepositUsd: 500 },
    exitOnHalt: false,
  });
  assert.equal(live.paperInitialDepositUsd, null);
});
