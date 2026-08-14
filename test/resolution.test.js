import test from 'node:test';
import assert from 'node:assert/strict';
import { ResolutionWatcher } from '../src/live/resolution.js';
import { GammaPriceToBeatProvider } from '../src/live/priceToBeat.js';
import { MarketResolver } from '../src/live/marketResolver.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('resolved market: outcomePrices ["1","0"] with outcomes ["Up","Down"] => UP', () => {
  assert.equal(
    ResolutionWatcher.parseGamma({ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["1","0"]' }),
    'UP'
  );
  assert.equal(
    ResolutionWatcher.parseGamma({ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0","1"]' }),
    'DOWN'
  );
});

test('winner follows the outcomes array, not array position', () => {
  assert.equal(
    ResolutionWatcher.parseGamma({ closed: true, outcomes: ['Down', 'Up'], outcomePrices: ['1', '0'] }),
    'DOWN'
  );
});

test('a near-certain live price is NOT a resolution', () => {
  assert.equal(
    ResolutionWatcher.parseGamma({ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0.98","0.02"]' }),
    null,
    '0.98 is a price, not a payout — settling on it would be wrong'
  );
});

test('an open market never resolves', () => {
  assert.equal(
    ResolutionWatcher.parseGamma({ closed: false, outcomes: '["Up","Down"]', outcomePrices: '["1","0"]' }),
    null
  );
});

test('resolution uses the canonical market slug endpoint after close', async () => {
  let requested = null;
  const w = new ResolutionWatcher({
    logger: quiet,
    fetchImpl: async (url) => {
      requested = url;
      return {
        ok: true,
        json: async () => ({
          closed: true,
          outcomes: '["Up","Down"]',
          outcomePrices: '["1","0"]',
        }),
      };
    },
  });
  assert.equal(
    await w.resolve({
      roundSlug: 'btc-updown-5m-1785231000',
      conditionId: '0x1',
      upIndex: 0,
    }),
    'UP'
  );
  assert.match(
    requested,
    /\/markets\/slug\/btc-updown-5m-1785231000$/
  );
});

test('gamma and chain disagreeing is treated as unresolved', async () => {
  const w = new ResolutionWatcher({
    logger: quiet,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["1","0"]' }],
    }),
    ethersProvider: {},
    ethersModule: {
      Contract: class {
        async payoutDenominator() { return 1n; }
        async payoutNumerators(_c, i) { return i === 1 ? 1n : 0n; } // chain says DOWN
      },
    },
  });
  const out = await w.resolve({ roundSlug: 'r', conditionId: '0x1', upIndex: 0 });
  assert.equal(out, null);
  assert.equal(w.stats.disagreements, 1);
});

test('chain resolution maps the winning INDEX through upIndex, not position', async () => {
  const mk = (upIndex) => new ResolutionWatcher({
    logger: quiet,
    fetchImpl: async () => ({ ok: true, json: async () => [{ closed: false }] }),
    ethersProvider: {},
    ethersModule: {
      Contract: class {
        async payoutDenominator() { return 1n; }
        async payoutNumerators(_c, i) { return i === 0 ? 1n : 0n; } // index 0 wins
      },
    },
  });
  assert.equal(await mk(0).resolve({ roundSlug: 'r', conditionId: '0x1', upIndex: 0 }), 'UP');
  assert.equal(await mk(1).resolve({ roundSlug: 'r', conditionId: '0x1', upIndex: 1 }), 'DOWN');
});

test('unreported oracle (denominator 0) is unresolved, not a loss', async () => {
  const w = new ResolutionWatcher({
    logger: quiet,
    fetchImpl: async () => ({ ok: true, json: async () => [{ closed: false }] }),
    ethersProvider: {},
    ethersModule: {
      Contract: class { async payoutDenominator() { return 0n; } async payoutNumerators() { return 0n; } },
    },
  });
  assert.equal(await w.resolve({ roundSlug: 'r', conditionId: '0x1', upIndex: 0 }), null);
});

test('authoritative chain resolution still works during a Gamma outage', async () => {
  const w = new ResolutionWatcher({
    logger: quiet,
    fetchImpl: async () => {
      throw new Error('gamma offline');
    },
    ethersProvider: {},
    ethersModule: {
      Contract: class {
        async payoutDenominator() { return 1n; }
        async payoutNumerators(_condition, index) {
          return index === 0 ? 1n : 0n;
        }
      },
    },
  });
  assert.equal(
    await w.resolve({ roundSlug: 'r', conditionId: '0x1', upIndex: 0 }),
    'UP'
  );
});

test('Gamma final is not realized before configured on-chain confirmation', async () => {
  const w = new ResolutionWatcher({
    logger: quiet,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{
        closed: true,
        outcomes: '["Up","Down"]',
        outcomePrices: '["1","0"]',
      }],
    }),
    ethersProvider: {},
    ethersModule: {
      Contract: class {
        async payoutDenominator() { return 0n; }
        async payoutNumerators() { return 0n; }
      },
    },
  });
  assert.equal(
    await w.resolve({ roundSlug: 'r', conditionId: '0x1', upIndex: 0 }),
    null
  );
});

test('marketResolver exposes upIndex for the on-chain path', () => {
  const m = MarketResolver.parseMarket(
    { clobTokenIds: '["111","222"]', outcomes: '["Down","Up"]', conditionId: '0x1' }, 'slug'
  );
  assert.equal(m.upIndex, 1);
  assert.equal(m.downIndex, 0);
  assert.equal(m.tokenIds.UP, '222');
});

test('market resolver does not cache a temporary no-market rejection', async () => {
  let requests = 0;
  const resolver = new MarketResolver({
    logger: quiet,
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        json: async () =>
          requests === 1
            ? []
            : [{
                clobTokenIds: '["up-token","down-token"]',
                outcomes: '["Up","Down"]',
                conditionId: '0x1',
              }],
      };
    },
  });
  await assert.rejects(
    resolver.resolve(1_785_231_600),
    /no market/
  );
  const market = await resolver.resolve(1_785_231_600);
  assert.equal(market.tokenIds.UP, 'up-token');
  assert.equal(requests, 2);
});

test('failed prefetch is evicted so round-open resolution can retry', async () => {
  let requests = 0;
  const resolver = new MarketResolver({
    logger: quiet,
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        json: async () =>
          requests === 1
            ? []
            : [{
                clobTokenIds: '["up-token","down-token"]',
                outcomes: '["Up","Down"]',
                conditionId: '0x1',
              }],
      };
    },
  });
  resolver.prefetchNext(1_785_231_300);
  await new Promise((resolve) => setImmediate(resolve));
  const market = await resolver.resolve(1_785_231_600);
  assert.equal(market.roundSlug, 'btc-updown-5m-1785231600');
  assert.equal(requests, 2);
});

// ------------------------------------------------------------ strike lookup
test('strike is read from an explicit numeric field and reports its source', () => {
  const out = GammaPriceToBeatProvider.extract({ strikePrice: 65159.581 });
  assert.equal(out.ptb, 65159.581);
  assert.equal(out.src, 'gamma:strikePrice');
});

test('strike is parsed out of the question text when no field exists', () => {
  const out = GammaPriceToBeatProvider.extract({
    question: 'Bitcoin Up or Down - will BTC close above $65,159.58?',
  });
  assert.equal(out.ptb, 65159.58);
  assert.ok(out.src.endsWith(':text'));
});

test('implausible numbers are rejected rather than logged as a strike', () => {
  assert.equal(GammaPriceToBeatProvider.extract({ strikePrice: 5 }), null);
  assert.equal(GammaPriceToBeatProvider.extract({ question: 'will BTC close above $5?' }), null);
  assert.equal(GammaPriceToBeatProvider.extract({}), null);
});
