import test from 'node:test';
import assert from 'node:assert/strict';
import { LegBook, MarketBook } from '../src/book.js';
import { RoundInventory } from '../src/inventory.js';
import {
  computeDesiredRungs,
  computeRungShares,
  PairRegime,
  roundRegime,
  SuppressReason,
} from '../src/quoter.js';
import { PARAMS, GUARDS } from '../src/config.js';

/** Build a 1c-wide book with the UP bid at `bidCents`. */
function mkBooks(bidCents, depth = 400) {
  const mk = (bb) => {
    const bids = [];
    const asks = [];
    for (let i = 0; i < 12; i += 1) {
      if (bb - i >= 1) bids.push({ price: (bb - i) / 100, size: depth });
      if (bb + 1 + i <= 99) asks.push({ price: (bb + 1 + i) / 100, size: depth });
    }
    return new LegBook(bids, asks, 0);
  };
  // DOWN mirrors UP: bidDown = 100 - askUp
  return new MarketBook(mk(bidCents), mk(99 - bidCents));
}

const G = () => structuredClone(GUARDS);
const inv = () => new RoundInventory('btc-updown-5m-1785140700', 1785140700);

test('clock gate: nothing before ENTRY_GATE_SECONDS, in either leg', () => {
  const gate = PARAMS.ENTRY_GATE_SECONDS;
  for (let t = 0; t < gate; t += 1) {
    const r = computeDesiredRungs({ secondsIntoRound: t, books: mkBooks(50), inventory: inv(), guards: G() });
    assert.equal(r.rungs.length, 0, `t=${t} should be silent`);
    assert.equal(r.suppressed[0].reason, SuppressReason.CLOCK_BEFORE_GATE);
  }
  const atGate = computeDesiredRungs({
    secondsIntoRound: gate,
    books: mkBooks(50),
    inventory: inv(),
    guards: G(),
  });
  assert.ok(atGate.rungs.length > 0, `t=${gate} may quote once observation is ready`);
});

test('target-style opening uses the normal two-sided passive ladder', () => {
  const opening = computeDesiredRungs({
    secondsIntoRound: PARAMS.ENTRY_GATE_SECONDS,
    books: mkBooks(50),
    inventory: inv(),
    guards: G(),
  });
  assert.deepEqual(
    new Set(opening.rungs.map((r) => r.leg)),
    new Set(['UP', 'DOWN'])
  );
  assert.ok(opening.rungs.every((r) => r.shares <= PARAMS.MAX_RUNG_SHARES));
  assert.equal(
    opening.rungs.filter((r) => r.leg === 'UP').length,
    PARAMS.LADDER_LEVELS
  );
  assert.equal(
    opening.rungs.filter((r) => r.leg === 'DOWN').length,
    PARAMS.LADDER_LEVELS
  );
});

test('target-style quoting continues through the final minute and stops at expiry', () => {
  const late = computeDesiredRungs({ secondsIntoRound: 240, books: mkBooks(50), inventory: inv(), guards: G() });
  assert.ok(late.rungs.length > 0);
  const r = computeDesiredRungs({ secondsIntoRound: 300, books: mkBooks(50), inventory: inv(), guards: G() });
  assert.equal(r.rungs.length, 0);
  assert.equal(r.suppressed[0].reason, SuppressReason.CLOCK_AFTER_STOP);
});

test('band gate: both legs quoted inside, offending leg dropped outside', () => {
  const inside = computeDesiredRungs({ secondsIntoRound: 100, books: mkBooks(50), inventory: inv(), guards: G() });
  assert.deepEqual(new Set(inside.rungs.map((r) => r.leg)), new Set(['UP', 'DOWN']));

  const outside = computeDesiredRungs({ secondsIntoRound: 100, books: mkBooks(93), inventory: inv(), guards: G() });
  assert.equal(outside.rungs.length, 0);
  assert.ok(outside.suppressed.every((s) => s.reason === SuppressReason.BAND_GATE));
});

test('band edge is inclusive at 12 and 89', () => {
  const r = computeDesiredRungs({ secondsIntoRound: 100, books: mkBooks(88), inventory: inv(), guards: G() });
  const legs = new Set(r.rungs.map((x) => x.leg));
  assert.equal(legs.size, 0, 'neutral V2 cycles require both quoted legs');
  assert.equal(
    r.suppressed.some(
      (row) => row.leg === 'UP' && row.reason === SuppressReason.BAND_GATE
    ),
    false,
    'the inclusive UP band edge itself remains valid'
  );
  assert.ok(
    r.suppressed.some(
      (row) => row.reason === SuppressReason.PAIR_PRICE_CAP
    )
  );
});

test('neutral quote set is withheld when simultaneous first-leg fills are uneconomic', () => {
  const books = new MarketBook(
    new LegBook(
      [{ price: 0.60, size: 500 }],
      [{ price: 0.61, size: 500 }],
      1
    ),
    new LegBook(
      [{ price: 0.50, size: 500 }],
      [{ price: 0.51, size: 500 }],
      1
    )
  );
  const result = computeDesiredRungs({
    secondsIntoRound: 100,
    books,
    inventory: inv(),
    guards: G(),
  });
  assert.equal(result.rungs.length, 0);
  const suppression = result.suppressed.find(
    (row) => row.reason === SuppressReason.PAIR_PRICE_CAP
  );
  assert.ok(suppression.detail.effectivePairMils > PARAMS.PAIR_TARGET_MILS);
});

test('placement is exactly one tick behind the bid', () => {
  const r = computeDesiredRungs({ secondsIntoRound: 100, books: mkBooks(50), inventory: inv(), guards: G() });
  const up = r.rungs.filter((x) => x.leg === 'UP').sort((a, b) => b.mils - a.mils);
  assert.equal(up[0].mils, 490, 'top UP rung sits at bid-1');
  assert.equal(up[0].offsetTicks, 1);
  assert.equal(up.length, PARAMS.LADDER_LEVELS);
  assert.equal(up[1].mils, 480, 'second rung one tick deeper');
});

test('dynamic rung size follows near-touch depth and soft-size throttling', () => {
  const thin = computeDesiredRungs({
    secondsIntoRound: 100, books: mkBooks(50, 50), inventory: inv(), guards: G(),
  });
  const deep = computeDesiredRungs({
    secondsIntoRound: 100, books: mkBooks(50, 500), inventory: inv(), guards: G(),
  });
  const medium = computeDesiredRungs({
    secondsIntoRound: 100, books: mkBooks(50, 100), inventory: inv(), guards: G(),
  });
  const spent = inv();
  spent.addFill('UP', 500, 400, 0); // $200 soft cap, below hard budget
  const throttled = computeDesiredRungs({
    secondsIntoRound: 100, books: mkBooks(50, 100), inventory: spent, guards: G(),
  });
  const thinSize = computeRungShares({
    book: mkBooks(50, 50).UP,
    inventory: inv(),
    guards: G(),
  });
  const deepSize = computeRungShares({
    book: mkBooks(50, 500).UP,
    inventory: inv(),
    guards: G(),
  });
  const mediumSize = computeRungShares({
    book: mkBooks(50, 100).UP,
    inventory: inv(),
    guards: G(),
  });
  const throttledSize = computeRungShares({
    book: mkBooks(50, 100).DOWN,
    inventory: spent,
    guards: G(),
  });
  assert.ok(deepSize > thinSize, 'deeper queues allow larger passive rungs');
  assert.ok(throttledSize < mediumSize, 'soft threshold halves new rung size');
  assert.equal(
    deep.rungs
      .filter((rung) => rung.leg === 'UP')
      .reduce((sum, rung) => sum + rung.shares, 0),
    PARAMS.MAX_UNMATCHED_SHARES,
    'neutral quotes cannot expose more than one unmatched cycle'
  );
  for (const rung of [...thin.rungs, ...medium.rungs, ...deep.rungs, ...throttled.rungs]) {
    assert.ok(rung.shares >= PARAMS.MIN_RUNG_SHARES);
    assert.ok(rung.shares <= PARAMS.MAX_RUNG_SHARES);
    assert.equal(rung.shares % PARAMS.RUNG_SIZE_STEP_SHARES, 0);
  }
});

test('dynamic sizing treats 10% depth as the aggregate allocation per leg', () => {
  const r = computeDesiredRungs({
    secondsIntoRound: 100,
    books: mkBooks(50, 50),
    inventory: inv(),
    guards: G(),
  });
  const up = r.rungs.filter((rung) => rung.leg === 'UP');
  assert.equal(
    up.reduce((total, rung) => total + rung.shares, 0),
    PARAMS.MAX_UNMATCHED_SHARES
  );
  assert.deepEqual(up.map((rung) => rung.shares), [5, 5]);
});

test('dynamic sizing never emits rungs below MIN_RUNG_SHARES', () => {
  // per-level depth 20 → 2-tick depth 60 → T=6 → one rung of 6 (not [5,1])
  const thin = computeDesiredRungs({
    secondsIntoRound: 100,
    books: mkBooks(50, 20),
    inventory: inv(),
    guards: G(),
  });
  const thinUp = thin.rungs.filter((r) => r.leg === 'UP');
  assert.equal(thinUp.length, 1);
  assert.equal(thinUp[0].shares, 6);

  // T=7 → [7]; T=9 → [9]; never a second illegal 1..4 share rung
  for (const [perLevel, expected] of [
    [25, 7],
    [30, 9],
  ]) {
    const r = computeDesiredRungs({
      secondsIntoRound: 100,
      books: mkBooks(50, perLevel),
      inventory: inv(),
      guards: G(),
    });
    const up = r.rungs.filter((x) => x.leg === 'UP');
    assert.equal(up.length, 1, `perLevel=${perLevel}`);
    assert.equal(up[0].shares, expected);
  }

  // 2-tick depth ≈105 (35×3) → T=10 → full two-rung ladder
  const full = computeDesiredRungs({
    secondsIntoRound: 100,
    books: mkBooks(50, 35),
    inventory: inv(),
    guards: G(),
  });
  assert.deepEqual(
    full.rungs.filter((r) => r.leg === 'UP').map((r) => r.shares),
    [5, 5]
  );

  // Soft-halved T=7 must not emit [5,2]
  const spent = inv();
  spent.addFill('UP', 500, 400, 0);
  const soft = computeDesiredRungs({
    secondsIntoRound: 100,
    books: mkBooks(50, 50),
    inventory: spent,
    guards: G(),
  });
  const softDown = soft.rungs.filter((r) => r.leg === 'DOWN');
  assert.equal(softDown.length, 1);
  assert.equal(softDown[0].shares, 7);

  for (const rung of [...thin.rungs, ...full.rungs, ...soft.rungs]) {
    assert.ok(rung.shares >= PARAMS.MIN_RUNG_SHARES);
  }
});

test('complement quote responds to FIFO lot cost without averaging', () => {
  const cheap = inv();
  cheap.addFill('DOWN', 200, 300, 0);
  const rich = inv();
  rich.addFill('DOWN', 750, 300, 0);
  const a = computeDesiredRungs({ secondsIntoRound: 100, books: mkBooks(50), inventory: cheap, guards: G() });
  const b = computeDesiredRungs({ secondsIntoRound: 100, books: mkBooks(50), inventory: rich, guards: G() });
  const upA = a.rungs.filter((r) => r.leg === 'UP').map((r) => r.mils);
  const upB = b.rungs.filter((r) => r.leg === 'UP').map((r) => r.mils);
  assert.deepEqual(upA, [490, 480]);
  assert.deepEqual(upB, [230]);
  assert.equal(a.complementCapMils, 780);
  assert.equal(b.complementCapMils, 230);
});

test('low-price leg is consolidated so every individual order is at least $1', () => {
  const lowPriceBooks = new MarketBook(
    new LegBook(
      [{ price: 0.11, size: 100 }],
      [{ price: 0.12, size: 100 }],
      1
    ),
    new LegBook(
      [{ price: 0.89, size: 100 }],
      [{ price: 0.90, size: 100 }],
      1
    )
  );
  const params = {
    ...PARAMS,
    BAND_LOW_MILS: 90,
    BAND_HIGH_MILS: 910,
    MIN_LIMIT_MILS: 90,
    MAX_LIMIT_MILS: 910,
  };
  const result = computeDesiredRungs({
    secondsIntoRound: 100,
    books: lowPriceBooks,
    inventory: inv(),
    params,
    guards: G(),
  });
  const up = result.rungs.filter((rung) => rung.leg === 'UP');
  assert.deepEqual(
    up.map(({ mils, shares }) => ({ mils, shares })),
    [{ mils: 100, shares: 10 }]
  );
  assert.ok(
    result.rungs.every((rung) => rung.shares * rung.mils >= 1000),
    'no desired order may be below $1'
  );
});

test('weak low-price allocation is withheld when it cannot fund a legal order', () => {
  const lowPriceBooks = new MarketBook(
    new LegBook(
      [{ price: 0.11, size: 50 }],
      [{ price: 0.12, size: 50 }],
      1
    ),
    new LegBook(
      [{ price: 0.89, size: 50 }],
      [{ price: 0.90, size: 50 }],
      1
    )
  );
  const result = computeDesiredRungs({
    secondsIntoRound: 100,
    books: lowPriceBooks,
    inventory: inv(),
    params: {
      ...PARAMS,
      BAND_LOW_MILS: 90,
      BAND_HIGH_MILS: 910,
      MIN_LIMIT_MILS: 90,
      MAX_LIMIT_MILS: 910,
    },
    guards: G(),
  });
  assert.equal(result.rungs.length, 0);
  assert.ok(
    result.suppressed.some(
      (row) =>
        row.leg === 'UP' &&
        row.reason === SuppressReason.LEG_SHARE_CAP &&
        row.detail.minimumShares === 10
    )
  );
});

test('ahead leg is suppressed and only its economically capped complement quotes', () => {
  const i = inv();
  i.addFill('UP', 500, GUARDS.MAX_TILT_SHARES, 0);
  const r = computeDesiredRungs({ secondsIntoRound: 100, books: mkBooks(50), inventory: i, guards: G() });
  const down = r.rungs.filter((x) => x.leg === 'DOWN').sort((a, b) => b.mils - a.mils);
  const up = r.rungs.filter((x) => x.leg === 'UP').sort((a, b) => b.mils - a.mils);
  assert.equal(down[0].offsetTicks, 1, 'lagging leg remains passive');
  assert.equal(up.length, 0, 'heavy leg cannot increase directional exposure');
  assert.ok(r.suppressed.some((x) => x.reason === SuppressReason.AHEAD_LEG));
  assert.ok(down.every((rung) => rung.mils <= 480));
});

test('round regimes use configured exact boundaries', () => {
  assert.equal(roundRegime(19), PairRegime.WARMUP);
  assert.equal(roundRegime(20), PairRegime.DISCOVERY);
  assert.equal(roundRegime(89), PairRegime.DISCOVERY);
  assert.equal(roundRegime(90), PairRegime.ACCUMULATION);
  assert.equal(roundRegime(209), PairRegime.ACCUMULATION);
  assert.equal(roundRegime(210), PairRegime.COMPLETION);
  assert.equal(roundRegime(260), PairRegime.RISK_REDUCTION);
  assert.equal(roundRegime(285), PairRegime.CLOSE_ONLY);
  assert.equal(roundRegime(300), PairRegime.CLOSED);
});

test('CLOSE_ONLY opens no cycle but still permits an economic complement', () => {
  const neutral = computeDesiredRungs({
    secondsIntoRound: 290,
    books: mkBooks(50),
    inventory: inv(),
    guards: G(),
  });
  assert.equal(neutral.rungs.length, 0);
  assert.ok(
    neutral.suppressed.some(
      (row) => row.reason === SuppressReason.PAIR_CYCLE_CLOSED
    )
  );

  const unmatched = inv();
  unmatched.addFill('UP', 400, 5, 280);
  const completion = computeDesiredRungs({
    secondsIntoRound: 290,
    books: mkBooks(50),
    inventory: unmatched,
    guards: G(),
  });
  assert.ok(completion.rungs.length > 0);
  assert.ok(completion.rungs.every((rung) => rung.leg === 'DOWN'));
  assert.ok(completion.rungs.every((rung) => rung.mils <= 580));
});

test('unmatched share cap suppresses ahead accumulation while allowing completion', () => {
  const inventory = inv();
  inventory.addFill('UP', 400, PARAMS.MAX_UNMATCHED_SHARES + 1, 95);
  const result = computeDesiredRungs({
    secondsIntoRound: 100,
    books: mkBooks(50),
    inventory,
    guards: G(),
  });
  assert.equal(result.rungs.some((rung) => rung.leg === 'UP'), false);
  assert.equal(result.rungs.some((rung) => rung.leg === 'DOWN'), true);
  assert.ok(
    result.suppressed.some(
      (row) => row.reason === SuppressReason.UNMATCHED_SHARE_CAP
    )
  );
});

test('hard round budget includes desired resting notional', () => {
  const i = inv();
  i.addFill('UP', 500, 240, 0);
  i.addFill('DOWN', 500, 240, 0);
  const r = computeDesiredRungs({
    secondsIntoRound: 100,
    books: mkBooks(50, 500),
    inventory: i,
    guards: G(),
  });
  const desiredUsd = r.rungs.reduce(
    (total, rung) => total + (rung.shares * rung.mils) / 1000,
    0
  );
  assert.ok(desiredUsd + i.totalNotionalUsd() <= GUARDS.MAX_ROUND_NOTIONAL_USD.hardLimit);
});

test('limit clamp never posts below 12c or above 89c', () => {
  const r = computeDesiredRungs({ secondsIntoRound: 100, books: mkBooks(13), inventory: inv(), guards: G() });
  for (const rung of r.rungs) {
    assert.ok(rung.mils >= PARAMS.MIN_LIMIT_MILS && rung.mils <= PARAMS.MAX_LIMIT_MILS);
  }
});

test('round notional and tilt guards are configured together', () => {
  assert.equal(Object.keys(GUARDS).length, 2);
  assert.ok(GUARDS.MAX_ROUND_NOTIONAL_USD.softLimit > 0);
  assert.ok(
    GUARDS.MAX_ROUND_NOTIONAL_USD.hardLimit >=
      GUARDS.MAX_ROUND_NOTIONAL_USD.softLimit
  );
  assert.ok(GUARDS.MAX_TILT_SHARES > 0);
});
