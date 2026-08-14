import { PARAMS, GUARDS } from './config.js';
import { RoundInventory } from './inventory.js';
import { OrderManager } from './orderManager.js';
import {
  checkEconomicInvariants,
  computeDesiredRungs,
  PairCycleState,
  PairRegime,
} from './quoter.js';
import {
  windowStartFromSlug,
  secondsIntoRound,
  toMils,
  roundAccounting,
} from './util.js';
import { NullRecorder } from './log/recorder.js';
import * as ev from './log/schema.js';

export const RoundState = {
  WARMUP: 'WARMUP',     // before ENTRY_GATE_SECONDS, idle by design
  QUOTING: 'QUOTING',   // entry gate <= t < quote stop
  SETTLING: 'SETTLING', // orders down, waiting for resolution
  PAUSED: 'PAUSED',     // recoverable strategy-level economic pause
  DONE: 'DONE',
};

/**
 * Drives one 5-minute round from open to redemption.
 *
 * Lifecycle:
 *   t=0     round opens; book is already 1c wide, strike already captured
 *   t<entry gate  warm up; no orders
 *   t>=gate quote both legs continuously, reprice on every book change
 *   t=300   cancel everything, hold both legs through resolution
 *   resolve hold winning shares (redemption is out of band)
 */
export class RoundRunner {
  /**
   * @param {Object} opts
   * @param {string} opts.roundSlug
   * @param {{UP:string,DOWN:string}} opts.tokenIds
   * @param {import('./exchange/interface.js').ExchangeAdapter} opts.exchange
   */
  constructor(opts) {
    this.roundSlug = opts.roundSlug;
    this.windowStartEpoch = opts.windowStartEpoch ?? windowStartFromSlug(opts.roundSlug);
    this.tokenIds = opts.tokenIds;
    this.exchange = opts.exchange;
    this.params = opts.params ?? PARAMS;
    this.guards = opts.guards ?? GUARDS;
    this.logger = opts.logger ?? console;
    this.recorder = opts.recorder ?? NullRecorder;
    this.sec = 0;

    this.inventory = new RoundInventory(this.roundSlug, this.windowStartEpoch);
    this.orders = new OrderManager(this.exchange, {
      roundSlug: this.roundSlug,
      params: this.params,
      logger: this.logger,
      recorder: this.recorder,
      secOf: () => this.sec,
      onInvariantBreach: opts.onInvariantBreach ?? null,
    });
    this.state = RoundState.WARMUP;
    this.lastSuppressed = [];
    this.currentPairRegime = PairRegime.WARMUP;
    this.currentPairCycleState = PairCycleState.NEUTRAL;
    this.currentComplementCapMils = null;
    this.strategyInvariantBreaches = [];
    this.pauseNewCycles = false;
    this.strategyPauseReason = null;
    this.markoutHorizonsMs = opts.markoutHorizonsMs ?? [250, 500, 1000, 2000, 5000];
    this.scheduleTimer = opts.scheduleTimer ?? setTimeout;
    this.firstFillSecond = null;
    this.lastFillSecond = null;
    this.feeUsd = 0;
    this.fillNotionalUsd = 0;
    this.sweptNotionalUsd = 0;
    this.lastIntentSig = null;
    this.lastIntentAtMs = 0;
    this.lastBookLogMs = 0;
    this.recorder.record(ev.roundOpen(this.roundSlug, this.windowStartEpoch, this.tokenIds));
  }

  /**
   * Restore a runner that was interrupted inside the same market window.
   * Called before the new market subscription starts, never from the quote
   * path. Live callers must only invoke this after venue share balances have
   * verified the snapshot (see accountReconcile).
   */
  restoreAccounting(snapshot) {
    if (!snapshot || snapshot.roundSlug !== this.roundSlug) {
      throw new Error(`accounting snapshot does not match ${this.roundSlug}`);
    }
    if (
      this.inventory.totalShares() > 0 ||
      this.inventory.fillCount() > 0
    ) {
      throw new Error(`cannot restore non-empty runner ${this.roundSlug}`);
    }
    const nonNegative = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? roundAccounting(n) : 0;
    };
    const upShares = nonNegative(snapshot.upShares);
    const downShares = nonNegative(snapshot.downShares);
    const upCostUsd = nonNegative(snapshot.upCostUsd);
    const downCostUsd = nonNegative(snapshot.downCostUsd);
    const upFillCount = Math.max(
      0,
      Math.trunc(Number(snapshot.upFillCount) || 0)
    );
    const downFillCount = Math.max(
      0,
      Math.trunc(Number(snapshot.downFillCount) || 0)
    );
    const totalFillCount = Math.max(
      upFillCount + downFillCount,
      Math.trunc(Number(snapshot.fillsCount) || 0)
    );

    const persistedLots = snapshot.inventoryAccounting?.lots;
    if (Array.isArray(persistedLots) && persistedLots.length > 0) {
      this.inventory.restoreLots(persistedLots);
      this.inventory.restoredFillCount = Math.max(
        0,
        totalFillCount - this.inventory.fills.length
      );
    } else {
      // Backward compatibility for V1 aggregate-only checkpoints. These
      // synthetic lots preserve the known economics; exact marginal FIFO
      // history was not available in the old format.
      if (upShares > 0) {
        this.inventory.addFill(
          'UP',
          (upCostUsd / upShares) * 1000,
          upShares,
          this.windowStartEpoch,
          { id: `${this.roundSlug}:legacy-up` }
        );
      }
      if (downShares > 0) {
        this.inventory.addFill(
          'DOWN',
          (downCostUsd / downShares) * 1000,
          downShares,
          this.windowStartEpoch,
          { id: `${this.roundSlug}:legacy-down` }
        );
      }
      this.inventory.restoredFillCount = Math.max(
        0,
        totalFillCount - this.inventory.fills.length
      );
    }
    Object.assign(this.inventory.legs.UP, {
      shares: upShares,
      costUsd: upCostUsd,
      fills: upFillCount,
    });
    Object.assign(this.inventory.legs.DOWN, {
      shares: downShares,
      costUsd: downCostUsd,
      fills: downFillCount,
    });
    this.feeUsd = nonNegative(snapshot.feeUsd);
    this.fillNotionalUsd = nonNegative(
      snapshot.fillNotionalUsd ?? upCostUsd + downCostUsd
    );
    this.sweptNotionalUsd = nonNegative(snapshot.sweptNotionalUsd);
    this.firstFillSecond =
      snapshot.firstFillSecond !== null &&
      snapshot.firstFillSecond !== undefined &&
      Number.isFinite(Number(snapshot.firstFillSecond))
        ? Number(snapshot.firstFillSecond)
        : null;
    this.lastFillSecond =
      snapshot.lastFillSecond !== null &&
      snapshot.lastFillSecond !== undefined &&
      Number.isFinite(Number(snapshot.lastFillSecond))
        ? Number(snapshot.lastFillSecond)
        : null;
    if (snapshot.orderStats && typeof snapshot.orderStats === 'object') {
      this.orders.stats = {
        ...this.orders.stats,
        ...snapshot.orderStats,
      };
    }
    return this;
  }

  /**
   * Chainlink open that the round settles against. Supplied by whoever has
   * it (the CLOB does not publish it on the market channel).
   */
  setPriceToBeat(info) {
    this.priceToBeat = info;
    this.recorder.record(ev.priceToBeat(this.roundSlug, { ...info, sec: this.sec }));
  }

  /**
   * Cheap change signature. Deliberately avoids JSON.stringify — this runs
   * on every book message, ~25 times a second.
   */
  static #intentSig(rungs, suppressed) {
    let s = '';
    for (const r of rungs) s += `${r.leg}${r.mils}:${r.shares}|`;
    if (suppressed.length) {
      s += '#';
      for (const x of suppressed) s += `${x.leg}${x.reason}|`;
    }
    return s;
  }

  #mkt(books) {
    return {
      up_bid: books.UP?.bestBid ?? null,
      up_ask: books.UP?.bestAsk ?? null,
      dn_bid: books.DOWN?.bestBid ?? null,
      dn_ask: books.DOWN?.bestAsk ?? null,
      up_depth2: books.UP?.bidDepthWithin(2) ?? null,
      dn_depth2: books.DOWN?.bidDepthWithin(2) ?? null,
      price_to_beat: this.priceToBeat?.ptb ?? null,
      price_to_beat_source: this.priceToBeat?.src ?? null,
      net_shares_up: this.inventory.shares('UP'),
      net_shares_down: this.inventory.shares('DOWN'),
      round_volume_usdc: this.inventory.totalNotionalUsd(),
    };
  }

  /**
   * Called on every book update for either leg. This is the whole hot path.
   * @param {import('./book.js').MarketBook} books
   * @param {number} nowEpochSeconds
   */
  async onBook(books, nowEpochSeconds, nowMs = Date.now()) {
    const t = secondsIntoRound(nowEpochSeconds, this.windowStartEpoch);
    this.sec = t;
    this.lastBooks = books;

    if (t >= this.params.QUOTE_STOP_SECONDS) {
      if (this.state !== RoundState.SETTLING && this.state !== RoundState.DONE) {
        this.state = RoundState.SETTLING;
        this.currentPairRegime = PairRegime.CLOSED;
        await this.orders.cancelAll();
        this.logger.info?.(
          `[${this.roundSlug}] settling ${JSON.stringify(this.inventory.snapshot())}`
        );
      }
      return;
    }

    if (t < this.params.PAIR_DISCOVERY_START_SECONDS) {
      this.state = RoundState.WARMUP;
      return;
    }

    this.state = RoundState.QUOTING;

    const decision = computeDesiredRungs({
      secondsIntoRound: t,
      books,
      inventory: this.inventory,
      params: this.params,
      guards: this.guards,
    });
    const {
      rungs,
      suppressed,
      regime,
      pairCycleState,
      complementCapMils,
      invariantBreaches,
      pauseNewCycles,
    } = decision;
    this.lastSuppressed = suppressed;
    this.currentPairRegime = regime;
    this.currentPairCycleState = pairCycleState;
    this.currentComplementCapMils = complementCapMils;
    this.strategyInvariantBreaches = invariantBreaches;
    this.pauseNewCycles = pauseNewCycles;
    const aheadLeg =
      this.inventory.unmatchedShares('UP') > 0
        ? 'UP'
        : this.inventory.unmatchedShares('DOWN') > 0
          ? 'DOWN'
          : null;
    this.currentPairCycleState = aheadLeg
      ? PairCycleState.WAITING_FOR_COMPLEMENT
      : PairCycleState.NEUTRAL;
    this.orders.setAheadLeg(aheadLeg);

    if (pairCycleState === PairCycleState.PAUSED) {
      this.state = RoundState.PAUSED;
      this.strategyPauseReason = invariantBreaches[0]?.reason ?? 'economic_invariant';
      await this.orders.cancelAll();
      this.recorder.record({
        t: Date.now(),
        type: 'strategy_pause',
        round: this.roundSlug,
        sec: t,
        reason: this.strategyPauseReason,
        breaches: invariantBreaches,
      });
      return decision;
    }
    this.strategyPauseReason = null;

    // Intents are logged even when nothing is sent: this is what lets you
    // reconstruct WHY a rung was absent (band gate, clamp).
    //
    // But the venue pushes ~9 book messages per second per leg, and 87% of
    // consecutive intents are byte-identical. Logging every one measured at
    // 801 MB/day. Log only on change, plus a heartbeat so "unchanged" stays
    // distinguishable from "dead".
    const sig = RoundRunner.#intentSig(rungs, suppressed);
    const nowMsF = nowMs;
    if (sig !== this.lastIntentSig || nowMsF - this.lastIntentAtMs >= this.params.INTENT_HEARTBEAT_MS) {
      this.lastIntentSig = sig;
      this.lastIntentAtMs = nowMsF;
      this.recorder.record(
        ev.quoteIntent(
          this.roundSlug,
          t,
          rungs,
          suppressed,
          this.#mkt(books),
          decision
        )
      );
    }

    // The rung set only changes when the BID moves, so a book where only the
    // ask moved would otherwise go unrecorded. A periodic snapshot keeps the
    // market reconstructable from the log alone.
    if (nowMsF - this.lastBookLogMs >= this.params.BOOK_SNAPSHOT_MS) {
      this.lastBookLogMs = nowMsF;
      this.recorder.record(
        ev.bookSnapshot(this.roundSlug, t, this.#mkt(books), books)
      );
    }

    await this.orders.reconcile(rungs, {
      roundSlug: this.roundSlug,
      tokenIds: this.tokenIds,
    }, nowMs);
  }

  /**
   * @param {Object} fill {leg, price (0..1), size, ts (epoch s)}
   */
  onFill(fill) {
    // After profit-lock / resolution, late maker fills must not reopen inventory.
    if (this.state === RoundState.DONE) return;

    const orderId = fill.orderId ?? null;
    // Live auto-balance books confirmed FAK fills immediately. A later user
    // feed trade for the same orderId must not double inventory, ledger, or fees.
    if (orderId && this.orders.wasProtectionFillBooked(orderId)) {
      return;
    }

    const mils = toMils(fill.price);
    const t = secondsIntoRound(fill.ts, this.windowStartEpoch);
    if (this.firstFillSecond === null) this.firstFillSecond = t;
    this.lastFillSecond = t;
    this.inventory.addFill(fill.leg, mils, fill.size, fill.ts, {
      feeUsd: fill.fee ?? 0,
      orderId,
      id: fill.fillId ?? undefined,
    });
    const aheadLeg =
      this.inventory.unmatchedShares('UP') > 0
        ? 'UP'
        : this.inventory.unmatchedShares('DOWN') > 0
          ? 'DOWN'
          : null;
    this.currentPairCycleState = aheadLeg
      ? PairCycleState.WAITING_FOR_COMPLEMENT
      : PairCycleState.NEUTRAL;
    this.orders.setAheadLeg(aheadLeg);
    this.orders.onFill({
      leg: fill.leg,
      mils,
      shares: fill.size,
      orderId,
      role: fill.role ?? null,
      fee: fill.fee ?? 0,
    });
    this.feeUsd = roundAccounting(
      this.feeUsd + Number(fill.fee ?? 0)
    );
    const fillNotional = fill.price * fill.size;
    this.fillNotionalUsd = roundAccounting(
      this.fillNotionalUsd + fillNotional
    );
    const ownMid = this.lastBooks?.[fill.leg]?.midMils;
    if (ownMid != null && mils - ownMid > 30) {
      this.sweptNotionalUsd = roundAccounting(
        this.sweptNotionalUsd + fillNotional
      );
    }

    const mkt = this.lastBooks ? this.#mkt(this.lastBooks) : null;
    if (mkt) mkt.own_bid = fill.leg === 'UP' ? mkt.up_bid : mkt.dn_bid;
    this.recorder.record(
      ev.fill(
        this.roundSlug,
        t,
        {
          leg: fill.leg,
          mils,
          shares: fill.size,
          role: fill.role ?? null,
          fee: fill.fee ?? 0,
          feeRateBps: fill.feeRateBps ?? null,
          orderId,
          full: fill.full ?? false,
          status: fill.status ?? null,
          transactionHash: fill.transactionHash ?? null,
          raw: fill.raw ?? null,
        },
        mkt,
        {
          up: this.inventory.shares('UP'),
          dn: this.inventory.shares('DOWN'),
          pairMils: this.inventory.pairCostMils(),
          tilt: this.inventory.tiltShares(),
          unmatchedUp: this.inventory.unmatchedShares('UP'),
          unmatchedDown: this.inventory.unmatchedShares('DOWN'),
          completedPairCount: this.inventory.completedPairs.length,
          completedPairEdgeUsd: this.inventory.completedPairEdgeUsd(),
          worstCasePnl: this.inventory.worstCasePnl(this.feeUsd),
          pairCycleState: this.currentPairCycleState,
        }
      )
    );

    this.#scheduleMakerMarkouts(fill, mils, t);

    this.strategyInvariantBreaches = checkEconomicInvariants(
      this.inventory,
      this.params,
      fill.ts
    );
    if (this.strategyInvariantBreaches.length) {
      this.pauseNewCycles = true;
      const hardPause = this.strategyInvariantBreaches.some(
        (breach) =>
          breach.reason === 'pair_hard_max' ||
          breach.reason === 'unmatched_both_sides'
      );
      this.strategyPauseReason = this.strategyInvariantBreaches[0].reason;
      this.recorder.record({
        t: Date.now(),
        type: 'strategy_invariant',
        round: this.roundSlug,
        sec: t,
        breaches: this.strategyInvariantBreaches,
        recoverable: true,
      });
      const cancellation = hardPause
        ? this.orders.cancelAll()
        : aheadLeg
          ? this.orders.cancelLeg(aheadLeg)
          : Promise.resolve();
      cancellation.catch((err) =>
        this.logger.error?.(
          `[${this.roundSlug}] economic invariant cancel failed: ${err.message}`
        )
      );
    }
  }

  #scheduleMakerMarkouts(fill, fillMils, roundSecond) {
    if (
      this.exchange?.mode !== 'live' ||
      String(fill.role ?? '').toUpperCase() !== 'MAKER'
    ) {
      return;
    }
    const inventoryState = Object.freeze({
      upShares: this.inventory.shares('UP'),
      downShares: this.inventory.shares('DOWN'),
      unmatchedUp: this.inventory.unmatchedShares('UP'),
      unmatchedDown: this.inventory.unmatchedShares('DOWN'),
      matchedShares: this.inventory.matchedShares(),
      tiltShares: this.inventory.tiltShares(),
    });
    const cycleState = this.currentPairCycleState;
    for (const horizonMs of this.markoutHorizonsMs) {
      const timer = this.scheduleTimer(() => {
        const future = this.lastBooks?.[fill.leg] ?? null;
        this.recorder.record(
          ev.makerMarkout({
            rid: this.roundSlug,
            fillMils,
            futureBestBidMils: future?.bestBid ?? null,
            futureMidMils: future?.midMils ?? null,
            horizonMs,
            leg: fill.leg,
            roundSecond,
            inventoryState,
            pairCycleState: cycleState,
          })
        );
      }, horizonMs);
      timer?.unref?.();
    }
  }

  /**
   * Lock this round after a successful auto-balance hedge (tilt flat).
   * Deterministic PnL: matched − cost − fees (same for either winner).
   */
  async closeAsHedged() {
    await this.orders.cancelAll();
    const matched = this.inventory.matchedShares();
    const costUsd = this.inventory.totalNotionalUsd();
    const tilt = this.inventory.tiltShares();
    if (Math.abs(tilt) >= 0.01) {
      throw new Error(
        `closeAsHedged: inventory still tilted (${tilt}); refusing lock`
      );
    }
    const grossPnlUsd = roundAccounting(matched - costUsd);
    const pnlUsd = Math.round((grossPnlUsd - this.feeUsd) * 1e6) / 1e6;
    this.state = RoundState.DONE;
    const out = {
      roundSlug: this.roundSlug,
      winner: 'HEDGED',
      payoutUsd: matched,
      costUsd,
      feeUsd: this.feeUsd,
      grossPnlUsd,
      pnlUsd,
      matchedShares: matched,
      tiltShares: 0,
      pairCostMils: this.inventory.pairCostMils(),
      fills: this.inventory.fillCount(),
      upShares: this.inventory.shares('UP'),
      downShares: this.inventory.shares('DOWN'),
      upAvgMils: this.inventory.avgMils('UP'),
      downAvgMils: this.inventory.avgMils('DOWN'),
      sweptNotionalFraction: this.fillsNotionalUsd
        ? this.sweptNotionalUsd / this.fillsNotionalUsd
        : 0,
      firstFillSecond: this.firstFillSecond,
      lastFillSecond: this.lastFillSecond,
      orderStats: { ...this.orders.stats },
      churnRatio: this.orders.churnRatio,
      settledBy: 'auto_balance',
    };
    const settlementEvent = ev.roundSettled(this.roundSlug, out, {
      feeUsd: this.feeUsd,
      shUp: out.upShares,
      shDn: out.downShares,
    });
    if (this.recorder.recordSettlement) {
      await this.recorder.recordSettlement(settlementEvent);
    } else {
      this.recorder.record(settlementEvent);
    }
    return out;
  }

  /**
   * Resolution. He holds every position to settlement —
   * there is no early exit path in the strategy and none is provided here.
   * @param {'UP'|'DOWN'} winner
   */
  async settle(winner) {
    if (this.state !== RoundState.SETTLING && this.state !== RoundState.QUOTING) {
      this.logger.warn?.(`[${this.roundSlug}] settle from state ${this.state}`);
    }
    await this.orders.cancelAll();
    const result = this.inventory.settle(winner);
    if (this.exchange.redeem) {
      const tokenId = this.tokenIds[winner];
      const shares = this.inventory.shares(winner);
      if (shares > 0) {
        try {
          await this.exchange.redeem({ tokenId, shares, roundSlug: this.roundSlug });
        } catch (err) {
          this.logger.error?.(`redeem failed ${this.roundSlug}: ${err.message}`);
        }
      }
    }
    this.state = RoundState.DONE;
    const out = {
      ...result,
      grossPnlUsd: result.pnlUsd,
      feeUsd: this.feeUsd,
      pnlUsd: Math.round((result.pnlUsd - this.feeUsd) * 1e6) / 1e6,
      upShares: this.inventory.shares('UP'),
      downShares: this.inventory.shares('DOWN'),
      upAvgMils: this.inventory.avgMils('UP'),
      downAvgMils: this.inventory.avgMils('DOWN'),
      sweptNotionalFraction: this.fillNotionalUsd
        ? this.sweptNotionalUsd / this.fillNotionalUsd
        : 0,
      firstFillSecond: this.firstFillSecond,
      lastFillSecond: this.lastFillSecond,
      orderStats: { ...this.orders.stats },
      churnRatio: this.orders.churnRatio,
    };
    const settlementEvent = ev.roundSettled(this.roundSlug, out, {
      feeUsd: this.feeUsd,
      shUp: this.inventory.shares('UP'),
      shDn: this.inventory.shares('DOWN'),
    });
    if (this.recorder.recordSettlement) {
      await this.recorder.recordSettlement(settlementEvent);
    } else {
      this.recorder.record(settlementEvent);
    }
    return out;
  }
}
