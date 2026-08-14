import test from 'node:test';
import assert from 'node:assert/strict';
import { LegBook } from '../src/book.js';
import { PaperExchange } from '../src/exchange/paperExchange.js';

const book = (bid, ask, bidSize = 100) =>
  new LegBook(
    [{ price: bid, size: bidSize }],
    [{ price: ask, size: 100 }],
    0
  );

test('explicit non-post-only quote crossed during latency is a taker with curve fee', async () => {
  const exchange = new PaperExchange({
    placeLatencyMs: 300,
    takerFeeRate: 0.07,
  });
  await exchange.placeLimitBuy({
    tokenId: 'UP',
    price: 0.49,
    size: 10,
    roundSlug: 'round',
    postOnly: false,
  });

  exchange.step('UP', book(0.47, 0.48), 1, 'round');

  assert.equal(exchange.fills.length, 1);
  assert.equal(exchange.fills[0].price, 0.48);
  assert.equal(exchange.fills[0].role, 'TAKER');
  assert.ok(Math.abs(exchange.fills[0].fee - 0.17472) < 1e-12);
});

test('ordinary post-only quote is rejected instead of becoming a taker', async () => {
  const rejected = [];
  const exchange = new PaperExchange({ placeLatencyMs: 300 });
  exchange.onRejectCallback = (event) => rejected.push(event);
  await exchange.placeLimitBuy({
    tokenId: 'UP',
    price: 0.49,
    size: 10,
    roundSlug: 'round',
  });
  exchange.step('UP', book(0.47, 0.48), 1, 'round');
  assert.equal(exchange.fills.length, 0);
  assert.equal(exchange.open.size, 0);
  assert.equal(rejected[0].reason, 'post_only_would_cross');
});

test('paper rejects placeLimitBuy below venue minimum of 5 shares', async () => {
  const rejected = [];
  const exchange = new PaperExchange({ placeLatencyMs: 0 });
  exchange.onRejectCallback = (event) => rejected.push(event);
  await assert.rejects(
    () =>
      exchange.placeLimitBuy({
        tokenId: 'UP',
        price: 0.49,
        size: 4,
        roundSlug: 'round',
      }),
    /lower than the minimum: 5/
  );
  assert.equal(exchange.open.size, 0);
  assert.equal(rejected[0].reason, 'size 4 lower than the minimum: 5');
});

test('fast fill after the order rests remains maker', async () => {
  const exchange = new PaperExchange({
    placeLatencyMs: 0,
    queueAheadFactor: 0,
    tradeFraction: 1,
    feeBps: 0,
  });
  await exchange.placeLimitBuy({
    tokenId: 'UP',
    price: 0.49,
    size: 10,
    roundSlug: 'round',
  });
  exchange.step('UP', book(0.49, 0.5, 100), 1, 'round');
  exchange.step('UP', book(0.48, 0.5, 100), 2, 'round');

  assert.equal(exchange.fills.length, 1);
  assert.equal(exchange.fills[0].price, 0.49);
  assert.equal(exchange.fills[0].role, 'MAKER');
  assert.equal(exchange.fills[0].fee, 0);
});

test('marketable place below $1 notional is rejected', async () => {
  const rejected = [];
  const exchange = new PaperExchange({ placeLatencyMs: 0 });
  exchange.onRejectCallback = (event) => rejected.push(event);
  await assert.rejects(
    () =>
      exchange.placeLimitBuy({
        tokenId: 'UP',
        price: 0.15,
        size: 5,
        roundSlug: 'round',
        postOnly: false,
      }),
    /invalid amount for a marketable BUY order/
  );
  assert.equal(exchange.open.size, 0);
  assert.match(rejected[0].reason, /min size: \$1/);
});

test('resting post-only below $1 notional is still accepted at place', async () => {
  const exchange = new PaperExchange({ placeLatencyMs: 0 });
  const { orderId } = await exchange.placeLimitBuy({
    tokenId: 'UP',
    price: 0.15,
    size: 5,
    roundSlug: 'round',
    postOnly: true,
  });
  assert.ok(orderId);
  assert.equal(exchange.open.size, 1);
  assert.equal(exchange.open.get(orderId).remaining, 5);
});

test('tradeFraction scales maker fill from bid shrinkage', async () => {
  const full = new PaperExchange({
    placeLatencyMs: 0,
    queueAheadFactor: 0,
    tradeFraction: 1,
    feeBps: 0,
  });
  const half = new PaperExchange({
    placeLatencyMs: 0,
    queueAheadFactor: 0,
    tradeFraction: 0.5,
    feeBps: 0,
  });

  for (const exchange of [full, half]) {
    await exchange.placeLimitBuy({
      tokenId: 'UP',
      price: 0.49,
      size: 20,
      roundSlug: 'round',
    });
    exchange.step('UP', book(0.49, 0.5, 100), 1, 'round');
    exchange.step('UP', book(0.49, 0.5, 80), 2, 'round');
  }

  assert.equal(full.fills.length, 1);
  assert.equal(half.fills.length, 1);
  assert.equal(full.fills[0].size, 20);
  assert.equal(half.fills[0].size, 10);
});

test('marketable buy walks asks up to its worst-price limit', async () => {
  const exchange = new PaperExchange({
    placeLatencyMs: 0,
    takerFeeRate: 0.07,
  });
  await exchange.placeLimitBuy({
    tokenId: 'DOWN',
    price: 0.68,
    size: 25,
    roundSlug: 'round',
    protection: true,
  });
  const depthBook = new LegBook(
    [{ price: 0.66, size: 100 }],
    [
      { price: 0.67, size: 10 },
      { price: 0.68, size: 20 },
    ]
  );
  exchange.step('DOWN', depthBook, 1, 'round');

  assert.equal(exchange.fills.length, 2);
  assert.deepEqual(
    exchange.fills.map((fill) => [fill.price, fill.size, fill.role]),
    [
      [0.67, 10, 'TAKER'],
      [0.68, 15, 'TAKER'],
    ]
  );
  assert.equal(exchange.open.size, 0);
});

test('FAK buy fills available ask depth then kills remainder', async () => {
  const exchange = new PaperExchange({
    placeLatencyMs: 0,
    takerFeeRate: 0.07,
  });
  await exchange.placeLimitBuy({
    tokenId: 'DOWN',
    price: 0.67,
    size: 25,
    roundSlug: 'round',
    orderType: 'FAK',
    protection: true,
  });
  const depthBook = new LegBook(
    [{ price: 0.66, size: 100 }],
    [{ price: 0.67, size: 10 }]
  );
  exchange.step('DOWN', depthBook, 1, 'round');

  assert.equal(exchange.fills.length, 1);
  assert.deepEqual(
    exchange.fills.map((fill) => [fill.price, fill.size, fill.role]),
    [[0.67, 10, 'TAKER']]
  );
  assert.equal(exchange.open.size, 0, 'FAK must not rest unfilled size');
});

test('FAK buy that is not marketable is killed without resting', async () => {
  const exchange = new PaperExchange({ placeLatencyMs: 0 });
  await exchange.placeLimitBuy({
    tokenId: 'UP',
    price: 0.4,
    size: 10,
    roundSlug: 'round',
    orderType: 'FAK',
  });
  exchange.step('UP', book(0.47, 0.48), 1, 'round');
  assert.equal(exchange.fills.length, 0);
  assert.equal(exchange.open.size, 0);
});

test('fillFakNow executes a FAK immediately despite place latency', async () => {
  const exchange = new PaperExchange({
    placeLatencyMs: 5000,
    takerFeeRate: 0,
  });
  const { orderId } = await exchange.placeLimitBuy({
    tokenId: 'DOWN',
    price: 0.99,
    size: 5,
    roundSlug: 'round',
    orderType: 'FAK',
    protection: true,
  });
  assert.equal(exchange.open.size, 1);
  exchange.fillFakNow(
    orderId,
    book(0.5, 0.51, 100),
    1,
    'round'
  );
  assert.equal(exchange.fills.length, 1);
  assert.equal(exchange.fills[0].role, 'TAKER');
  assert.equal(exchange.fills[0].size, 5);
  assert.equal(exchange.open.size, 0);
});
