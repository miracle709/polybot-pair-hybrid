import { toMils, complementMils, tickSizeMils } from './util.js';

/**
 * A single leg's book, in integer mils (price x 1000).
 *
 * Polymarket's UP and DOWN tokens are exact complements: bidDown(p) is the
 * same resting liquidity as askUp(100-p). In the capture, `bidDown == 1 -
 * askUp` held in 94.5% of ticks — the residual is snapshot skew between the
 * two feeds, not a real arbitrage. `fromComplement` exists so you can
 * synthesise one leg's book from the other when only one stream is healthy.
 */
export class LegBook {
  /**
   * @param {Array<{price:number,size:number}>} bids descending by price
   * @param {Array<{price:number,size:number}>} asks ascending by price
   * @param {number} ts epoch seconds of this snapshot
   */
  constructor(bids = [], asks = [], ts = 0) {
    this.bids = LegBook.#normalise(bids, 'desc');
    this.asks = LegBook.#normalise(asks, 'asc');
    this.ts = ts;
  }

  static #normalise(levels, dir) {
    const out = levels
      .map((l) => ({ mils: toMils(l.price), size: Number(l.size) }))
      .filter((l) => l.size > 0 && l.mils >= 1 && l.mils <= 999);
    out.sort((a, b) => (dir === 'desc' ? b.mils - a.mils : a.mils - b.mils));
    return out;
  }

  get bestBid() {
    return this.bids.length ? this.bids[0].mils : null;
  }

  get bestAsk() {
    return this.asks.length ? this.asks[0].mils : null;
  }

  /**
   * Mid in mils. Returns a half-integer for a 10-mil book (e.g. 335),
   * which is correct — the band gate compares against it numerically and
   * never uses it to derive a price level.
   *
   * The book is 1c (10 mils) wide in 96% of ticks, so mid is bid+5.
   */
  get midMils() {
    const b = this.bestBid;
    const a = this.bestAsk;
    if (b === null || a === null) return null;
    return (b + a) / 2;
  }

  get spreadMils() {
    const b = this.bestBid;
    const a = this.bestAsk;
    return b === null || a === null ? null : a - b;
  }

  sizeAt(mils) {
    const hit = this.bids.find((l) => l.mils === mils);
    return hit ? hit.size : 0;
  }

  /**
   * Resting bid size within `ticks` of the touch. Median near-touch depth
   * in the capture was 373 shares per side within 2 ticks — a 90-share
   * rung is ~24% of that queue, which is worth logging.
   */
  bidDepthWithin(ticks) {
    const b = this.bestBid;
    if (b === null) return 0;
    const span = ticks * tickSizeMils(b);
    return this.bids
      .filter((l) => l.mils >= b - span)
      .reduce((s, l) => s + l.size, 0);
  }

  isCrossed() {
    const b = this.bestBid;
    const a = this.bestAsk;
    return b !== null && a !== null && b >= a;
  }

  isUsable() {
    return this.bestBid !== null && this.bestAsk !== null && !this.isCrossed();
  }

  /** Build this leg's book by mirroring the complementary leg's book. */
  static fromComplement(other) {
    const bids = other.asks.map((l) => ({
      price: complementMils(l.mils) / 1000,
      size: l.size,
    }));
    const asks = other.bids.map((l) => ({
      price: complementMils(l.mils) / 1000,
      size: l.size,
    }));
    return new LegBook(bids, asks, other.ts);
  }
}

/** Both legs at one instant. */
export class MarketBook {
  constructor(up, down) {
    this.UP = up;
    this.DOWN = down;
  }

  get(leg) {
    const b = this[leg];
    if (!b) throw new RangeError(`MarketBook: no book for leg ${leg}`);
    return b;
  }

  /**
   * Cost of assembling one pair by lifting both bids. Median 990 in the
   * capture — the 1c floor edge. Above 100 means the two snapshots are
   * skewed; treat as stale rather than as free money.
   */
  get pairBidCostMils() {
    const u = this.UP?.bestBid;
    const d = this.DOWN?.bestBid;
    return u === null || d === null || u === undefined || d === undefined
      ? null
      : u + d;
  }

  bothUsable() {
    return !!this.UP?.isUsable() && !!this.DOWN?.isUsable();
  }
}
