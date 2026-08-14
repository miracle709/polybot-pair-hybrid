import test from 'node:test';
import assert from 'node:assert/strict';

import { LegBook, MarketBook } from '../src/book.js';
import { exOwnBookFeatures } from '../src/signals/bookFeatures.js';
import { FeatureEngine } from '../src/signals/featureEngine.js';
import { SourceQuality, sourceQuality } from '../src/signals/sourceQuality.js';
import { TimeSeriesBuffer } from '../src/signals/timeSeriesBuffer.js';

function booksAt(timeMs, upBid = 0.49) {
  const ts = timeMs / 1000;
  return new MarketBook(
    new LegBook(
      [{ price: upBid, size: 100 }, { price: upBid - 0.01, size: 100 }],
      [{ price: upBid + 0.01, size: 100 }, { price: upBid + 0.02, size: 100 }],
      ts
    ),
    new LegBook(
      [{ price: 0.99 - upBid, size: 100 }, { price: 0.98 - upBid, size: 100 }],
      [{ price: 1 - upBid, size: 100 }, { price: 1.01 - upBid, size: 100 }],
      ts
    )
  );
}

test('fixed-horizon return uses an observation at or before t-h and excludes future arrivals', () => {
  const buffer = new TimeSeriesBuffer();
  buffer.add({ value: 100, publisherTimeMs: 91_000, arrivalTimeMs: 91_000 });
  buffer.add({ value: 100.5, publisherTimeMs: 92_000, arrivalTimeMs: 96_000 });
  buffer.add({ value: 101, publisherTimeMs: 93_000, arrivalTimeMs: 93_000 });
  buffer.add({ value: 102, publisherTimeMs: 95_000, arrivalTimeMs: 95_000 });
  buffer.add({ value: 999, publisherTimeMs: 96_000, arrivalTimeMs: 96_000 });

  const result = buffer.fixedHorizonLogReturnBps(95_000, 3_000);
  assert.equal(result.current.publisherTimeMs, 95_000);
  assert.equal(result.targetTimeMs, 92_000);
  assert.equal(result.past.publisherTimeMs, 91_000);
  assert.ok(Math.abs(result.value - 10_000 * Math.log(102 / 100)) < 1e-9);
});

test('time-weighted average is causal and requires a left-window anchor', () => {
  const buffer = new TimeSeriesBuffer();
  buffer.add({ value: 100, publisherTimeMs: 0, arrivalTimeMs: 0 });
  buffer.add({ value: 110, publisherTimeMs: 5_000, arrivalTimeMs: 5_000 });
  buffer.add({ value: 999, publisherTimeMs: 11_000, arrivalTimeMs: 11_000 });
  const twap = buffer.timeWeightedAverage(10_000, 10_000);
  assert.equal(twap.value, 105);
  const noAnchor = new TimeSeriesBuffer();
  noAnchor.add({ value: 100, publisherTimeMs: 1_000, arrivalTimeMs: 1_000 });
  assert.equal(noAnchor.timeWeightedAverage(10_000, 10_000), null);
});

test('source quality never promotes ambiguous Chainlink or exchange spot names', () => {
  assert.equal(sourceQuality('chainlink_data_streams'), SourceQuality.AUTHORITATIVE);
  assert.equal(sourceQuality('chainlink_onchain_approx'), SourceQuality.APPROXIMATE);
  assert.equal(sourceQuality('binance_spot'), SourceQuality.APPROXIMATE);
  assert.equal(sourceQuality('chainlink'), SourceQuality.UNTRUSTED);
});

test('own bid and complementary bid are removed from CLOB signal book', () => {
  const books = new MarketBook(
    new LegBook(
      [{ price: 0.5, size: 5 }, { price: 0.49, size: 20 }],
      [{ price: 0.51, size: 5 }, { price: 0.52, size: 20 }],
      100
    ),
    new LegBook(
      [{ price: 0.49, size: 5 }, { price: 0.48, size: 20 }],
      [{ price: 0.5, size: 5 }, { price: 0.51, size: 20 }],
      100
    )
  );
  const features = exOwnBookFeatures(books, [
    { leg: 'UP', mils: 500, restingShares: 5 },
    { leg: 'DOWN', mils: 490, restingShares: 5 },
  ]);
  assert.equal(features.up.bestBid, 490);
  assert.equal(features.up.bestAsk, 520);
  assert.equal(features.up.midMils, 505);
  assert.equal(features.ownQuoteContaminated, false);

  const inconsistent = exOwnBookFeatures(books, [
    { leg: 'UP', mils: 500, restingShares: 6 },
  ]);
  assert.equal(inconsistent.ownQuoteContaminated, true);
});

test('FeatureEngine constructs a valid causal snapshot and strict freshness invalidates it', () => {
  const engine = new FeatureEngine({
    roundSlug: 'round',
    windowStartEpoch: 70,
    roundSeconds: 300,
    bookMaxAgeMs: 1000,
    btcMaxAgeMs: 1000,
    referenceMaxAgeMs: 1500,
  });
  const priceToBeat = {
    ptb: 100,
    src: 'chainlink_data_streams',
    publisherTimeMs: 69_000,
    arrivalTimeMs: 69_000,
  };
  let snapshot;
  for (let timeMs = 70_000; timeMs <= 100_000; timeMs += 1_000) {
    const price = 100 + (timeMs - 70_000) / 100_000;
    engine.observeBtc({
      price,
      source: 'binance_spot',
      publisherTimeMs: timeMs,
      arrivalTimeMs: timeMs,
    });
    engine.observeSettlementReference({
      price,
      source: 'chainlink_data_streams',
      publisherTimeMs: timeMs,
      arrivalTimeMs: timeMs,
    });
    snapshot = engine.buildSnapshot({
      books: booksAt(timeMs, 0.49 + ((timeMs / 1000) % 2) * 0.001),
      priceToBeat,
      decisionTimeMs: timeMs,
      roundSecond: (timeMs - 70_000) / 1000,
    });
  }
  assert.equal(snapshot.valid, true, snapshot.invalidReasons.join(','));
  assert.ok(Number.isFinite(snapshot.btcReturn10sBps));
  assert.ok(Number.isFinite(snapshot.clobReturn10sBps));
  assert.ok(Number.isFinite(snapshot.rawGapBps));
  assert.ok(Number.isFinite(snapshot.twap30GapBps));
  assert.equal(snapshot.priceToBeatSourceQuality, SourceQuality.AUTHORITATIVE);

  const stale = engine.buildSnapshot({
    books: booksAt(100_000),
    priceToBeat,
    decisionTimeMs: 102_001,
    roundSecond: 32.001,
  });
  assert.equal(stale.valid, false);
  assert.ok(stale.invalidReasons.includes('book_stale'));
  assert.ok(stale.invalidReasons.includes('btc_stale'));
  assert.ok(stale.invalidReasons.includes('settlement_reference_stale'));
});

test('future source timestamps invalidate a SignalSnapshot', () => {
  const engine = new FeatureEngine({ roundSlug: 'future', windowStartEpoch: 0 });
  engine.observeBtc({ price: 100, source: 'spot', publisherTimeMs: 900, arrivalTimeMs: 900 });
  engine.observeSettlementReference({ price: 100, source: 'chainlink_data_streams', publisherTimeMs: 900, arrivalTimeMs: 900 });
  const snapshot = engine.buildSnapshot({
    books: booksAt(900),
    priceToBeat: {
      ptb: 100,
      src: 'chainlink_data_streams',
      publisherTimeMs: 1100,
      arrivalTimeMs: 1100,
    },
    decisionTimeMs: 1000,
    roundSecond: 1,
  });
  assert.equal(snapshot.valid, false);
  assert.ok(snapshot.invalidReasons.includes('price_to_beat_future_timestamp'));
});

