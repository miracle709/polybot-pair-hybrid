import { ExchangeAdapter } from './interface.js';
import { toMils, roundShares } from '../util.js';
import {
  POLYMARKET_MIN_ORDER_NOTIONAL_USD,
  POLYMARKET_MIN_ORDER_SHARES,
} from '../orderConstraints.js';
import { cryptoTakerFeeUsd } from '../fees.js';
import { PRIORITY } from '../live/rateLimiter.js';

/**
 * Queue-aware paper / JSONL-replay exchange (no real CLOB orders).
 *
 * Driven by a live public book (`npm run paper`) or captured L2 snapshots
 * (`run-replay.js`). Same fill engine in both cases.
 *
 * FILL MODEL — read this before trusting any simulated number.
 *
 * A resting buy at price p fills when sellers hit the bid queue at p. The
 * simulator measures that directly: the shrinkage of resting bid size at
 * our own price level between consecutive snapshots is the volume that
 * traded through us. If the level disappears entirely, the book traded
 * below us and the whole level cleared.
 *
 * Queue position is modelled, not ignored. Depth resting at your price level
 * when you arrive is queue-ahead; you only fill after it clears. This matters
 * more than usual here: median near-touch depth is 373 shares per side and a
 * 90-share rung is ~24% of it, so assuming instant priority would overstate
 * fills badly.
 *
 * Known limitations, stated plainly:
 *   - 1-second snapshots. Sub-second sweeps are invisible, so fast-move
 *     fills (the adverse-selection bucket) are UNDER-represented. A backtest
 *     will look better than live. Budget for that.
 *   - Consumption cannot be told apart from cancellation at the same level,
 *     so fills are somewhat over-estimated in a heavily-cancelled book.
 *     `tradeFraction` (default 0.6) scales observed shrinkage before queue
 *     accounting to reduce that optimism without a second queue lever.
 *   - Do NOT read PnL off this harness. It exists to validate BEHAVIOUR —
 *     gates, offsets, sizes, tilt — against the checklist in metrics.js.
 *   - Your own orders are not in the captured book, so market impact and
 *     the queue you displace are not modelled.
 *   - Cancel latency is modelled as a fixed delay, not a distribution.
 */
export class PaperExchange extends ExchangeAdapter {
  constructor(opts = {}) {
    super();
    this.mode = 'paper';
    this.orderSeq = 0;
    /** @type {Map<string, any>} */
    this.open = new Map();
    this.fills = [];
    this.onRejectCallback = opts.onReject ?? null;
    this.cancelLatencyMs = opts.cancelLatencyMs ?? 600;
    this.placeLatencyMs = opts.placeLatencyMs ?? 600;
    this.queueAheadFactor = opts.queueAheadFactor ?? 1.0;
    this.tradeFraction = opts.tradeFraction ?? 0.6;
    this.feeBps = opts.feeBps ?? 0;
    this.takerFeeRate = opts.takerFeeRate ?? 0.07;
    this.limiter = opts.limiter ?? null;
    this.nowMs = 0;
    this.prevBook = new Map();
    this.market = null;
    this.paperStats = { fills: 0, shares: 0, notionalUsd: 0, feeUsd: 0 };
    this.externalFillHandler = null;
    const userOnFill = opts.onFill ?? null;
    this.onFillCallback = (fill) => {
      this.paperStats.fills += 1;
      this.paperStats.shares += fill.size;
      this.paperStats.notionalUsd += fill.price * fill.size;
      this.paperStats.feeUsd += fill.fee ?? 0;
      this.externalFillHandler?.(fill);
      userOnFill?.(fill);
    };
  }

  /**
   * Single reject path for venue-parity failures.
   * @param {string|null} orderId
   * @param {string} reason
   * @param {{ throwError?: boolean }} [opts]
   */
  #reject(orderId, reason, opts = {}) {
    if (orderId != null) this.open.delete(orderId);
    this.onRejectCallback?.({ orderId, reason });
    if (opts.throwError !== false) {
      throw new Error(reason);
    }
  }

  static #minimumNotionalReason(price, size) {
    const notional = Number(price) * Number(size);
    const usd = Number(notional.toFixed(6));
    return (
      `order notional $${usd} lower than the minimum: ` +
      `$${POLYMARKET_MIN_ORDER_NOTIONAL_USD}`
    );
  }

  setFillHandler(handler) {
    this.externalFillHandler = handler;
  }

  setOrderRejectHandler(handler) {
    this.onRejectCallback = handler;
  }

  setMarket({ roundSlug, tokenIds }) {
    this.open.clear();
    this.prevBook.clear();
    this.market = {
      roundSlug,
      tokenIds: {
        UP: String(tokenIds.UP),
        DOWN: String(tokenIds.DOWN),
      },
    };
  }

  setClock(ms) {
    this.nowMs = ms;
  }

  async placeLimitBuy(req) {
    await this.limiter?.acquire(1, PRIORITY.PLACE);

    const {
      tokenId,
      price,
      size,
      roundSlug,
      offsetTicks = null,
      protection = false,
      orderType = 'GTC',
      postOnly = !protection,
    } = req;

    let leg = req.leg ?? tokenId;
    if (this.market) {
      leg =
        String(tokenId) === this.market.tokenIds.UP
          ? 'UP'
          : String(tokenId) === this.market.tokenIds.DOWN
            ? 'DOWN'
            : null;
      if (!leg) {
        throw new Error(`paper exchange: unknown token id ${tokenId}`);
      }
    }

    const fak = orderType === 'FAK' || orderType === 'fak';
    const effectivePostOnly = fak ? false : postOnly;

    // Match Polymarket venue minimum so paper cannot credit illegal top-ups.
    if (!(Number(size) >= POLYMARKET_MIN_ORDER_SHARES)) {
      this.#reject(
        null,
        `size ${size} lower than the minimum: ${POLYMARKET_MIN_ORDER_SHARES}`
      );
    }

    // Polymarket rejects every order whose submitted price x size is under $1.
    if (
      Number(price) * Number(size) + 1e-12 <
      POLYMARKET_MIN_ORDER_NOTIONAL_USD
    ) {
      this.#reject(
        null,
        PaperExchange.#minimumNotionalReason(price, size)
      );
    }

    this.orderSeq += 1;
    const id = `paper-${this.orderSeq}`;
    this.open.set(id, {
      id,
      tokenId: String(tokenId),
      leg,
      mils: toMils(price),
      remaining: size,
      roundSlug,
      offsetTicksAtPlacement: offsetTicks,
      protection,
      orderType: fak ? 'FAK' : 'GTC',
      postOnly: effectivePostOnly,
      // FAK hedges must be executable inside autoBalance without waiting on
      // the next websocket book tick or place-latency delay.
      restsAtMs: fak ? this.nowMs : this.nowMs + this.placeLatencyMs,
      queueAhead: null,
      armed: false,
      offsetTicks: null,
    });
    return { orderId: id };
  }

  /**
   * Immediately apply a resting FAK against a book snapshot (auto-balance).
   * Ordinary GTC quotes still wait for onMarketBook / step.
   */
  fillFakNow(orderId, book, tsSeconds, roundSlug) {
    const o = this.open.get(orderId);
    if (!o || o.orderType !== 'FAK') return;
    this.nowMs = Number(tsSeconds) * 1000;
    o.restsAtMs = this.nowMs;
    this.step(o.leg, book, tsSeconds, roundSlug ?? o.roundSlug);
  }

  async cancelOrders(orderIds) {
    await this.limiter?.acquire(1, PRIORITY.CANCEL);
    for (const id of orderIds) {
      const o = this.open.get(id);
      if (o) o.cancelAtMs = this.nowMs + this.cancelLatencyMs;
    }
  }

  async cancelEverything() {
    await this.limiter?.acquire(1, PRIORITY.CANCEL);
    const cancelled = this.open.size;
    this.open.clear();
    return { cancelled };
  }

  async redeem() {
    /* settlement handled by the replay / supervisor path */
  }

  async getFeeSchedule() {
    return { takerBps: this.feeBps, makerBps: this.feeBps };
  }

  /**
   * Advance simulated resting orders against a MarketBook (live paper path).
   * Must run before Engine.onBook(): fills happen before the strategy reprices.
   * @param {{ protectionOnly?: boolean }} [opts] when true, only FAK/protection
   *   orders match (used while auto-balance has paused quoting).
   */
  onMarketBook(books, tsSeconds, roundSlug, opts = {}) {
    if (!this.market || roundSlug !== this.market.roundSlug) return;
    this.step('UP', books.UP, tsSeconds, roundSlug, opts);
    this.step('DOWN', books.DOWN, tsSeconds, roundSlug, opts);
  }

  /**
   * Advance the simulation one book snapshot.
   * @param {'UP'|'DOWN'} leg
   * @param {import('../book.js').LegBook} book
   * @param {number} tsSeconds
   * @param {string} roundSlug orders from other rounds must not fill here
   * @param {{ protectionOnly?: boolean }} [opts]
   */
  step(leg, book, tsSeconds, roundSlug, opts = {}) {
    this.nowMs = tsSeconds * 1000;
    const prev = this.prevBook.get(leg) ?? null;
    const protectionOnly = Boolean(opts.protectionOnly);

    for (const [id, o] of [...this.open]) {
      if (o.leg !== leg) continue;
      if (roundSlug !== undefined && o.roundSlug !== roundSlug) continue;
      if (protectionOnly && !o.protection) continue;

      if (o.cancelAtMs !== undefined && this.nowMs >= o.cancelAtMs) {
        this.open.delete(id);
        continue;
      }
      if (this.nowMs < o.restsAtMs) continue;

      if (
        !o.marketableChecked &&
        book.bestAsk != null &&
        o.mils >= book.bestAsk
      ) {
        o.marketableChecked = true;
        if (o.postOnly) {
          this.#reject(id, 'post_only_would_cross', { throwError: false });
          continue;
        }
        const feeRate = this.takerFeeRate ?? 0.07;
        for (const level of book.asks) {
          if (o.remaining <= 0.01 || level.mils > o.mils) break;
          const filled = roundShares(
            Math.min(o.remaining, level.size)
          );
          if (filled <= 0) continue;
          const price = level.mils / 1000;
          o.remaining = roundShares(o.remaining - filled);
          const fill = {
            leg,
            price,
            size: filled,
            fee: cryptoTakerFeeUsd(filled, price, feeRate),
            ts: tsSeconds,
            orderId: id,
            roundSlug: o.roundSlug,
            offsetTicks: o.offsetTicksAtPlacement,
            role: 'TAKER',
            full: o.remaining <= 0.01,
          };
          this.fills.push(fill);
          if (this.onFillCallback) this.onFillCallback(fill);
        }
        if (o.remaining <= 0.01 || o.orderType === 'FAK') {
          // FAK: kill any unfilled remainder; do not rest in the book.
          this.open.delete(id);
          continue;
        }
      } else if (o.orderType === 'FAK') {
        // Not marketable at check time — FAK dies immediately.
        o.marketableChecked = true;
        this.open.delete(id);
        continue;
      }

      if (o.queueAhead === null) {
        o.queueAhead = book.sizeAt(o.mils) * this.queueAheadFactor;
        continue;
      }
      if (!prev) continue;

      const before = prev.sizeAt(o.mils);
      const after = book.sizeAt(o.mils);
      let rawConsumed = 0;
      if (before > 0) {
        rawConsumed = after > 0 ? Math.max(0, before - after) : before;
      }
      let consumed = roundShares(rawConsumed * this.tradeFraction);
      if (consumed <= 0) continue;

      if (o.queueAhead > 0) {
        const eaten = Math.min(o.queueAhead, consumed);
        o.queueAhead = roundShares(o.queueAhead - eaten);
        consumed = roundShares(consumed - eaten);
      }
      if (consumed <= 0) continue;

      const filled = roundShares(Math.min(o.remaining, consumed));
      if (filled <= 0) continue;

      o.remaining = roundShares(o.remaining - filled);
      const fill = {
        leg,
        price: o.mils / 1000,
        size: filled,
        fee: (o.mils / 1000) * filled * (this.feeBps / 10000),
        role: 'MAKER',
        ts: tsSeconds,
        orderId: id,
        roundSlug: o.roundSlug,
        offsetTicks: o.offsetTicksAtPlacement,
      };
      this.fills.push(fill);
      if (this.onFillCallback) this.onFillCallback(fill);
      if (o.remaining <= 0.01) this.open.delete(id);
    }

    this.prevBook.set(leg, book);
  }

  reset() {
    this.open.clear();
    this.fills = [];
    this.prevBook.clear();
  }

  paperSummary() {
    return {
      fills: this.paperStats.fills,
      shares: Math.round(this.paperStats.shares * 100) / 100,
      notionalUsd: Math.round(this.paperStats.notionalUsd * 100) / 100,
      feeUsd: Math.round(this.paperStats.feeUsd * 10000) / 10000,
      openOrders: this.open.size,
      model: {
        queueAware: true,
        noLookAhead: true,
        liveMarkoutCalibrated: false,
        validatesProfitability: false,
        queueAheadFactor: this.queueAheadFactor,
        tradeFraction: this.tradeFraction,
        placeLatencyMs: this.placeLatencyMs,
        cancelLatencyMs: this.cancelLatencyMs,
      },
    };
  }
}
