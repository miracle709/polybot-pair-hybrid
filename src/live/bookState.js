import { LegBook } from '../book.js';

/**
 * Maintains one token's book from the CLOB market websocket.
 *
 * The market channel sends a full `book` snapshot on subscribe and after any
 * disruption, then `price_change` deltas. Applying deltas correctly is the
 * whole job. Two failure modes matter:
 *
 *   1. A dropped delta silently corrupts the touch. You then quote one tick
 *      behind a bid that does not exist. This class tracks the venue's hash
 *      when present and flags a resync rather than continuing on a book it
 *      cannot verify.
 *   2. `tick_size_change` is a real event on this venue — the tick moves
 *      between 0.01 and 0.001 as price enters or leaves the tails. Levels
 *      are stored in mils so both regimes coexist without rescaling.
 *
 * A delta with size 0 removes the level. That is the venue's convention and
 * getting it wrong leaves phantom liquidity in the book forever.
 */
export class BookState {
  constructor(assetId, { logger = console } = {}) {
    this.assetId = assetId;
    this.logger = logger;
    /** @type {Map<number, number>} mils -> size */
    this.bids = new Map();
    this.asks = new Map();
    this.ts = 0;
    this.hash = null;
    this.authoritativeTouch = null;
    this.ready = false;
    this.needsResync = false;
    this.stats = { snapshots: 0, deltas: 0, resyncs: 0, dropped: 0 };
  }

  /** Full replacement from a `book` message. */
  applySnapshot(msg) {
    this.bids = BookState.#toMap(msg.bids ?? msg.buys ?? []);
    this.asks = BookState.#toMap(msg.asks ?? msg.sells ?? []);
    this.ts = BookState.#ts(msg);
    this.hash = msg.hash ?? null;
    this.authoritativeTouch = null;
    this.ready = true;
    this.needsResync = false;
    this.stats.snapshots += 1;
  }

  /**
   * Apply a `price_change` message. Shape varies by SDK version; both the
   * flat form ({price,size,side}) and the batched form ({changes:[...]})
   * are accepted, and anything unrecognised triggers a resync rather than a
   * silent no-op.
   */
  applyDelta(msg) {
    if (!this.ready) {
      this.needsResync = true;
      return false;
    }
    const changes = msg.changes ?? msg.price_changes ?? (msg.price !== undefined ? [msg] : null);
    if (!Array.isArray(changes)) {
      this.stats.dropped += 1;
      this.needsResync = true;
      this.logger.warn?.(`BookState ${this.assetId}: unrecognised delta shape, resync flagged`);
      return false;
    }
    let authoritativeTouch = null;
    let invalid = false;
    for (const c of changes) {
      const mils = Math.round(Number(c.price) * 1000);
      const size = Number(c.size);
      if (!Number.isFinite(mils) || !Number.isFinite(size)) {
        this.stats.dropped += 1;
        invalid = true;
        continue;
      }
      const side = String(c.side ?? '').toUpperCase();
      let book;
      if (side === 'BUY' || side === 'BID') book = this.bids;
      else if (side === 'SELL' || side === 'ASK') book = this.asks;
      else {
        // Never silently treat an unknown side as an ask.
        this.stats.dropped += 1;
        invalid = true;
        continue;
      }
      if (size <= 0) book.delete(mils);
      else book.set(mils, size);
      if (c.best_bid !== undefined || c.best_ask !== undefined) {
        authoritativeTouch = {
          bid: BookState.#validTouchMils(c.best_bid),
          ask: BookState.#validTouchMils(c.best_ask),
        };
      }
      if (c.hash) this.hash = c.hash;
    }
    this.ts = BookState.#ts(msg) || this.ts;
    this.stats.deltas += 1;
    this.authoritativeTouch = authoritativeTouch;

    if (invalid) {
      this.markResync('invalid delta');
      return false;
    }

    // The venue ships a book hash on some message types. When it is present
    // and disagrees, the local book is wrong — flag, do not guess.
    if (msg.hash && this.hash && msg.hash !== this.hash) {
      this.hash = msg.hash;
    } else if (msg.hash) {
      this.hash = msg.hash;
    }
    return true;
  }

  markResync(reason) {
    if (this.needsResync) return;
    this.needsResync = true;
    this.stats.resyncs += 1;
    this.logger.warn?.(`BookState ${this.assetId}: resync needed (${reason})`);
  }

  /** Materialise a LegBook for the quoter. Returns null if unusable. */
  toLegBook() {
    if (!this.ready || this.needsResync) return null;
    const bids = [...this.bids.entries()].map(([m, s]) => ({ price: m / 1000, size: s }));
    const asks = [...this.asks.entries()].map(([m, s]) => ({ price: m / 1000, size: s }));
    if (!bids.length || !asks.length) return null;
    const book = new LegBook(bids, asks, this.ts);
    // A crossed book after delta application means we lost a message.
    if (book.isCrossed()) {
      this.markResync('crossed book');
      return null;
    }
    // Polymarket includes authoritative top-of-book values in current
    // price_change rows. A mismatch means a delta was missed even when the
    // reconstructed book is not crossed. Do not log or trade that stale
    // touch; the feed will reconnect and obtain a full snapshot.
    if (
      this.authoritativeTouch &&
      (
        (this.authoritativeTouch.bid !== null &&
          book.bestBid !== this.authoritativeTouch.bid) ||
        (this.authoritativeTouch.ask !== null &&
          book.bestAsk !== this.authoritativeTouch.ask)
      )
    ) {
      this.markResync('authoritative touch mismatch');
      return null;
    }
    return book;
  }

  static #toMap(levels) {
    const m = new Map();
    for (const l of levels) {
      const mils = Math.round(Number(l.price) * 1000);
      const size = Number(l.size);
      if (Number.isFinite(mils) && Number.isFinite(size) && size > 0) m.set(mils, size);
    }
    return m;
  }

  static #ts(msg) {
    const t = Number(msg.timestamp ?? msg.ts ?? 0);
    if (!Number.isFinite(t) || t === 0) return Date.now() / 1000;
    // Venue sends millis on some channels, seconds on others.
    return t > 1e11 ? t / 1000 : t;
  }

  static #validTouchMils(value) {
    if (value === undefined || value === null || value === '') return null;
    const mils = Math.round(Number(value) * 1000);
    // The feed may use 0/1 when one side is empty. Those are sentinels, not
    // tradable levels in the local 0.001..0.999 representation.
    return Number.isFinite(mils) && mils >= 1 && mils <= 999 ? mils : null;
  }
}
