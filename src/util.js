/**
 * Price arithmetic in MILS (price x 1000, integer, 1..999).
 *
 * Why mils and not cents: Polymarket's CLOB does not use a uniform 1c grid.
 * The tick is 0.01 in the body of the book and 0.001 in the tails. Verified
 * against the capture: 425 of 78,194 sampled book levels sit off the cent
 * grid (0.984, 0.016, 0.991, 0.009, 0.924 ...), every one of them outside
 * 0.10-0.90. An integer-cent model throws on real data.
 *
 * The target wallet only ever quotes inside 0.12-0.89, where the tick is
 * always 10 mils, but his BOOK contains tail levels and the bot has to
 * parse them without choking.
 *
 * Floating-point probabilities exist only at the exchange boundary.
 */

export const MILS = 1000;

/** Polymarket tick size at a given price level, in mils. */
export function tickSizeMils(mils) {
  return mils >= 100 && mils <= 900 ? 10 : 1;
}

/** 0.34 -> 340, 0.984 -> 984. Throws if not on the 0.001 grid. */
export function toMils(prob) {
  if (typeof prob !== 'number' || !Number.isFinite(prob)) {
    throw new TypeError(`toMils: expected finite number, got ${prob}`);
  }
  const m = Math.round(prob * MILS);
  if (Math.abs(prob * MILS - m) > 1e-6) {
    throw new RangeError(`toMils: ${prob} is not on the 0.001 grid`);
  }
  return m;
}

/** 340 -> 0.34. Trailing zeros trimmed so payloads match venue formatting. */
export function toProb(mils) {
  if (!Number.isInteger(mils)) {
    throw new TypeError(`toProb: expected integer mils, got ${mils}`);
  }
  return Number((mils / MILS).toFixed(3));
}

/** Cents, for human-facing output only. Never for arithmetic. */
export function toCentsDisplay(mils) {
  return mils / 10;
}

/** The complementary leg's price. UP at 340 <=> DOWN at 660. */
export function complementMils(mils) {
  return MILS - mils;
}

/**
 * Step `n` ticks away from `mils`, respecting the variable grid.
 * Walking down from 105 by 1 tick gives 95 (10-mil tick at 105, then the
 * 1-mil regime below 100 is entered at the next step, not this one).
 */
export function stepTicks(mils, n) {
  let p = mils;
  const dir = Math.sign(n);
  for (let i = 0; i < Math.abs(n); i += 1) {
    p += dir * tickSizeMils(dir < 0 ? p - 1 : p);
  }
  return p;
}

export function otherLeg(leg) {
  if (leg === 'UP') return 'DOWN';
  if (leg === 'DOWN') return 'UP';
  throw new RangeError(`otherLeg: unknown leg ${leg}`);
}

export function roundShares(x) {
  return Math.round(x * 100) / 100;
}

/** Accounting precision. UI formatting must not leak into PnL arithmetic. */
export function roundAccounting(x) {
  return Math.round(Number(x) * 1e9) / 1e9;
}

/** Notional in USD for a size at a mil price. */
export function notionalUsd(shares, mils) {
  return roundAccounting((shares * mils) / MILS);
}

export function rungKey(leg, mils) {
  return `${leg}@${mils}`;
}

export function secondsIntoRound(nowEpochSeconds, windowStartEpoch) {
  return Math.floor(nowEpochSeconds - windowStartEpoch);
}

export function windowStartFromSlug(slug) {
  const tail = slug.slice(slug.lastIndexOf('-') + 1);
  const n = Number(tail);
  if (!Number.isInteger(n)) throw new RangeError(`bad slug: ${slug}`);
  return n;
}

export function nowSeconds() {
  return Date.now() / 1000;
}
