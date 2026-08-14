import { PARAMS } from './config.js';
import { minimumOrderSharesForParams } from './orderConstraints.js';
import { rungKey, roundShares, toProb } from './util.js';
import { NullRecorder } from './log/recorder.js';
import * as ev from './log/schema.js';

function provenanceOf(value) {
  const output = {};
  for (const key of [
    'strategyIntent',
    'actionCandidateId',
    'signalSnapshotId',
    'modelVersion',
    'expectedEdgeAtDecision',
  ]) {
    if (value?.[key] != null) output[key] = value[key];
  }
  return output;
}

/**
 * Reconciles the desired rung set against what is actually resting on the
 * exchange: cancel what is no longer wanted, place what is missing, top up
 * what has been partially eaten.
 *
 * The churn this produces is the real shape of his bot. Against ~108
 * one-tick mid changes per round he ends up with only 12-30 filled orders,
 * so roughly 90% of everything posted is cancelled unfilled. If your
 * cancel-to-fill ratio is far below ~9:1 you are resting too passively;
 * far above and you are burning rate limit for nothing.
 */
export class OrderManager {
  /**
   * @param {import('./exchange/interface.js').ExchangeAdapter} exchange
   * @param {Object} [opts]
   */
  constructor(exchange, opts = {}) {
    this.exchange = exchange;
    // Set at construction, not lazily in reconcile(): cancelAll() can fire
    // on a round that never quoted (band gate held all 300s), and an
    // undefined round id in the log is worse than no log line.
    this.roundSlug = opts.roundSlug ?? null;
    this.params = opts.params ?? PARAMS;
    this.logger = opts.logger ?? console;
    // Recorder is injected, never constructed here. NullRecorder keeps the
    // call sites free of null checks and compiles down to a no-op.
    this.recorder = opts.recorder ?? NullRecorder;
    /** () => seconds into round, for log context only */
    this.secOf = opts.secOf ?? (() => null);
    /** @type {Map<string, {leg:string,mils:number,targetShares:number,restingShares:number,orderId:string,placedAtMs:number}>} */
    this.live = new Map();
    /** Per-round lifecycle ledger used by cold-path monitoring. */
    this.orderLedger = new Map();
    this.ledgerVersion = 0;
    this.rejectedSeq = 0;
    this.stats = {
      placed: 0,
      cancelled: 0,
      replenished: 0,
      filledShares: 0,
      placeErrors: 0,
      cancelErrors: 0,
    };
    this.lastReconcileMs = 0;
    /**
     * reconcile() awaits network I/O. At ~25 book messages/sec it was being
     * re-entered before the previous pass finished, so each overlapping run
     * posted rungs the other had not yet recorded. Observed live: 28 resting
     * orders against an expected maximum of 4, a 37-deep limiter queue and
     * 5.2-second cancel latency.
     */
    this.busy = false;
    /** Newest desired state received while network reconciliation is busy. */
    this.pendingDesired = null;
    this.idleWaiters = [];
    /** Current unmatched/ahead leg, updated synchronously on every fill. */
    this.aheadLeg = null;
    /** @type {Set<string>} FAK protection fills already applied to inventory */
    this.bookedProtectionFills = new Set();
    /** Optional halt escalation when live order count exceeds LADDER_LEVELS*2 */
    this.onInvariantBreach = opts.onInvariantBreach ?? null;
  }

  wasProtectionFillBooked(orderId) {
    return orderId != null && this.bookedProtectionFills.has(String(orderId));
  }

  markProtectionFillBooked(orderId) {
    if (orderId != null) this.bookedProtectionFills.add(String(orderId));
  }

  setAheadLeg(leg) {
    this.aheadLeg = leg === 'UP' || leg === 'DOWN' ? leg : null;
  }

  provenanceFor(orderId) {
    if (orderId == null) return Object.freeze({});
    return Object.freeze(provenanceOf(this.orderLedger.get(String(orderId))));
  }

  /**
   * @param {import('./quoter.js').DesiredRung[]} desired
   * @param {Object} roundCtx {roundSlug, tokenIds:{UP,DOWN}}
   */
  async reconcile(desired, roundCtx, nowMs = Date.now()) {
    if (this.busy) {
      this.pendingDesired = { desired, roundCtx, nowMs };
      this.stats.coalescedUpdates = (this.stats.coalescedUpdates ?? 0) + 1;
      return { skipped: true, reason: 'coalesced' };
    }
    if (nowMs - this.lastReconcileMs < this.params.MIN_REQUOTE_INTERVAL_MS) {
      return { skipped: true, reason: 'throttled' };
    }
    this.lastReconcileMs = nowMs;
    this.busy = true;
    try {
      let request = { desired, roundCtx, nowMs };
      let firstResult = null;
      let coalescedProcessed = 0;
      while (request) {
        this.lastReconcileMs = request.nowMs;
        const result = await this.#reconcile(
          request.desired,
          request.roundCtx
        );
        if (firstResult === null) firstResult = result;
        request = this.pendingDesired;
        this.pendingDesired = null;
        if (request) coalescedProcessed += 1;
      }
      return { ...firstResult, coalescedProcessed };
    } finally {
      this.busy = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  async #reconcile(desired, roundCtx) {

    const wanted = new Map(desired.map((d) => [d.key, d]));
    const toCancel = [];
    const toPlace = [];

    // 1. anything live that is no longer wanted gets pulled.
    for (const [key, order] of this.live) {
      if (!wanted.has(key)) toCancel.push(order);
    }

    // 2. anything wanted that is not live gets posted; anything live but
    //    partially consumed gets topped back up to the full rung.
    for (const [key, want] of wanted) {
      const minShares = minimumOrderSharesForParams(want.mils, this.params);
      const have = this.live.get(key);
      if (!have) {
        toPlace.push({ ...want, replenish: false });
      } else if (have.restingShares > want.shares + 0.01) {
        // Dynamic sizing can reduce a rung while its price stays unchanged.
        // Orders cannot be amended atomically, so cancel then replace.
        toCancel.push(have);
        toPlace.push({ ...want, replenish: false });
      } else if (
        this.params.REPLENISH_PARTIAL_RUNGS &&
        have.restingShares < want.shares - 0.01
      ) {
        const deficit = roundShares(want.shares - have.restingShares);
        if (deficit >= minShares) {
          toPlace.push({
            ...want,
            shares: deficit,
            replenish: true,
          });
        } else if (deficit > 0.01) {
          // Polymarket rejects a top-up below its share or $1 notional floor.
          // Cancel and re-post the full desired rung instead.
          toCancel.push(have);
          toPlace.push({ ...want, replenish: false });
        }
      }
    }

    // Cancels first: frees collateral and avoids tripping per-market order
    // count limits when the touch walks and every rung reprices at once.
    await Promise.all(toCancel.map((o) => this.#cancel(o)));
    const safeToPlace = toPlace.filter((rung) => {
      if (
        !this.params.REPLENISH_AHEAD_LEG &&
        this.aheadLeg &&
        rung.leg === this.aheadLeg
      ) {
        this.stats.aheadPlacementsSuppressed =
          (this.stats.aheadPlacementsSuppressed ?? 0) + 1;
        return false;
      }
      return rung.replenish || !this.live.has(rung.key);
    });
    if (safeToPlace.some((o) => o.opening)) {
      // During the opening probation, do not have multiple orders crossing
      // the network simultaneously. Each order must be acknowledged before
      // the next is submitted.
      for (const order of safeToPlace) {
        // eslint-disable-next-line no-await-in-loop
        await this.#place(order, roundCtx);
      }
    } else {
      await Promise.all(safeToPlace.map((o) => this.#place(o, roundCtx)));
    }

    // Invariant: at most LADDER_LEVELS rungs per leg. If this trips, the
    // reconciler has lost track of what is resting — escalate to halt rather
    // than keep quoting into an unknown book.
    const maxLive = this.params.LADDER_LEVELS * 2;
    if (this.live.size > maxLive) {
      this.stats.invariantBreaches = (this.stats.invariantBreaches ?? 0) + 1;
      const reason =
        `OrderManager invariant breach: ${this.live.size} live orders, max ${maxLive}`;
      this.logger.error?.(reason);
      try {
        this.onInvariantBreach?.({
          live: this.live.size,
          maxLive,
          reason,
          roundSlug: this.roundSlug,
        });
      } catch (err) {
        this.logger.error?.(
          `onInvariantBreach handler failed: ${err.message}`
        );
      }
      return {
        skipped: false,
        cancelled: toCancel.length,
        placed: safeToPlace.length,
        live: this.live.size,
        invariantBreach: true,
      };
    }

    return {
      skipped: false,
      cancelled: toCancel.length,
      placed: safeToPlace.length,
      live: this.live.size,
    };
  }

  async #place(rung, roundCtx) {
    const tokenId = roundCtx.tokenIds[rung.leg];
    if (!tokenId) {
      this.logger.warn?.(`no tokenId for leg ${rung.leg} in ${roundCtx.roundSlug}`);
      return;
    }
    const minShares = minimumOrderSharesForParams(rung.mils, this.params);
    if (!(rung.shares >= minShares)) {
      const minimumNotionalUsd = Math.max(
        1,
        this.params.MIN_ORDER_NOTIONAL_USD ?? 1
      );
      const err = new Error(
        `size ${rung.shares} lower than minimum ${minShares} at ` +
          `$${toProb(rung.mils)} ($${minimumNotionalUsd} minimum notional)`
      );
      this.stats.placeErrors += 1;
      const rejectedId = `rejected-${++this.rejectedSeq}`;
      this.orderLedger.set(rejectedId, {
        orderId: rejectedId,
        roundId: roundCtx.roundSlug,
        leg: rung.leg,
        side: 'BUY',
        mils: rung.mils,
        price: toProb(rung.mils),
        avgFillMils: null,
        originalShares: rung.shares,
        filledShares: 0,
        remainingShares: 0,
        status: 'rejected',
        reason: err.message,
        role: null,
        feeUsd: 0,
        placedAtMs: Date.now(),
        updatedAtMs: Date.now(),
        ...provenanceOf(rung),
      });
      this.ledgerVersion += 1;
      this.recorder.record(
        ev.orderRejected(roundCtx.roundSlug, this.secOf(), {
          leg: rung.leg,
          mils: rung.mils,
          shares: rung.shares,
          reason: err.message,
        })
      );
      this.logger.warn?.(`place failed ${rung.leg}@${rung.mils}: ${err.message}`);
      return;
    }
    try {
      const res = await this.exchange.placeLimitBuy({
        tokenId,
        price: toProb(rung.mils),
        size: rung.shares,
        roundSlug: roundCtx.roundSlug,
        offsetTicks: rung.offsetTicks,
        protection: !!rung.protection,
        postOnly: !rung.protection,
        ...provenanceOf(rung),
      });
      const key = rungKey(rung.leg, rung.mils);
      const existing = this.live.get(key);
      if (existing && rung.replenish) {
        existing.restingShares = roundShares(existing.restingShares + rung.shares);
        existing.replenishOrderIds = (existing.replenishOrderIds ?? []).concat(res.orderId);
        this.stats.replenished += 1;
      } else {
        this.live.set(key, {
          leg: rung.leg,
          mils: rung.mils,
          targetShares: rung.shares,
          restingShares: rung.shares,
          orderId: res.orderId,
          placedAtMs: Date.now(),
          ...provenanceOf(rung),
        });
        this.stats.placed += 1;
      }
      this.orderLedger.set(res.orderId, {
        orderId: res.orderId,
        roundId: roundCtx.roundSlug,
        leg: rung.leg,
        side: 'BUY',
        mils: rung.mils,
        price: toProb(rung.mils),
        avgFillMils: null,
        originalShares: rung.shares,
        filledShares: 0,
        remainingShares: rung.shares,
        status: 'resting',
        replenish: !!rung.replenish,
        protection: !!rung.protection,
        role: null,
        feeUsd: 0,
        placedAtMs: Date.now(),
        updatedAtMs: Date.now(),
        ...provenanceOf(rung),
      });
      this.ledgerVersion += 1;
      this.recorder.record(
        ev.orderPlaced(roundCtx.roundSlug, this.secOf(), {
          leg: rung.leg,
          mils: rung.mils,
          shares: rung.shares,
          offsetTicks: rung.offsetTicks,
          orderId: res.orderId,
          replenish: rung.replenish,
          protection: !!rung.protection,
          ...provenanceOf(rung),
        })
      );
    } catch (err) {
      this.stats.placeErrors += 1;
      const rejectedId = `rejected-${++this.rejectedSeq}`;
      this.orderLedger.set(rejectedId, {
        orderId: rejectedId,
        roundId: roundCtx.roundSlug,
        leg: rung.leg,
        side: 'BUY',
        mils: rung.mils,
        price: toProb(rung.mils),
        avgFillMils: null,
        originalShares: rung.shares,
        filledShares: 0,
        remainingShares: 0,
        status: 'rejected',
        reason: err.message,
        role: null,
        feeUsd: 0,
        placedAtMs: Date.now(),
        updatedAtMs: Date.now(),
        ...provenanceOf(rung),
      });
      this.ledgerVersion += 1;
      this.recorder.record(
        ev.orderRejected(roundCtx.roundSlug, this.secOf(), {
          leg: rung.leg,
          mils: rung.mils,
          shares: rung.shares,
          reason: err.message,
        })
      );
      this.logger.warn?.(`place failed ${rung.leg}@${rung.mils}: ${err.message}`);
    }
  }

  async #cancel(order) {
    const key = rungKey(order.leg, order.mils);
    try {
      const ids = [order.orderId, ...(order.replenishOrderIds ?? [])];
      await this.exchange.cancelOrders(ids);
      this.stats.cancelled += 1;
      const updatedAtMs = Date.now();
      for (const id of ids) {
        const tracked = this.orderLedger.get(id);
        if (tracked && tracked.status !== 'filled') {
          tracked.status = 'cancelled';
          tracked.updatedAtMs = updatedAtMs;
        }
      }
      this.ledgerVersion += 1;
      this.recorder.record(
        ev.orderCancelled(this.roundSlug, this.secOf(), {
          leg: order.leg,
          mils: order.mils,
          orderIds: ids,
          restingShares: order.restingShares,
          ageMs: Date.now() - order.placedAtMs,
        })
      );
      this.live.delete(key);
    } catch (err) {
      this.stats.cancelErrors += 1;
      for (const id of [order.orderId, ...(order.replenishOrderIds ?? [])]) {
        const tracked = this.orderLedger.get(id);
        if (tracked && tracked.status !== 'filled') {
          tracked.status = 'cancel_failed';
          tracked.reason = err.message;
          tracked.updatedAtMs = Date.now();
        }
      }
      this.ledgerVersion += 1;
      this.logger.warn?.(`cancel failed ${key}: ${err.message}`);
    }
  }

  /**
   * Apply a fill reported by the exchange. Reduces the resting size on that
   * rung; the next reconcile tops it back up if REPLENISH_PARTIAL_RUNGS.
   * role/feeUsd are booked only when filledShares actually increases.
   */
  onFill({ leg, mils, shares, orderId = null, role = null, fee = 0 }) {
    const key = rungKey(leg, mils);
    const order = this.live.get(key);
    this.stats.filledShares = roundShares(this.stats.filledShares + shares);

    let tracked = orderId ? this.orderLedger.get(orderId) : null;
    if (!tracked) {
      tracked = [...this.orderLedger.values()].find(
        (o) =>
          o.leg === leg &&
          o.mils === mils &&
          (o.status === 'resting' || o.status === 'partial')
      );
    }
    if (tracked) {
      const prevFilled = tracked.filledShares;
      tracked.filledShares = roundShares(
        Math.min(tracked.originalShares, tracked.filledShares + shares)
      );
      const applied = roundShares(tracked.filledShares - prevFilled);
      tracked.remainingShares = roundShares(
        Math.max(0, tracked.originalShares - tracked.filledShares)
      );
      tracked.status = tracked.remainingShares <= 0.01 ? 'filled' : 'partial';
      if (role && !tracked.role) tracked.role = role;
      if (applied > 0.01) {
        const fillMils = Number(mils);
        if (Number.isFinite(fillMils)) {
          const prevAvg =
            Number.isFinite(tracked.avgFillMils) && prevFilled > 0.01
              ? tracked.avgFillMils
              : fillMils;
          tracked.avgFillMils =
            prevFilled > 0.01
              ? (prevAvg * prevFilled + fillMils * applied) /
                tracked.filledShares
              : fillMils;
          tracked.price = tracked.avgFillMils / 1000;
        }
        const feePart = Number(fee) || 0;
        if (feePart > 0) {
          tracked.feeUsd = Math.round((tracked.feeUsd + feePart) * 1e5) / 1e5;
        }
      }
      tracked.updatedAtMs = Date.now();
      this.ledgerVersion += 1;
    }

    if (!order) return;
    order.restingShares = roundShares(Math.max(0, order.restingShares - shares));
    if (order.restingShares <= 0.01) this.live.delete(key);
  }

  onReject({ orderId, reason = 'rejected' }) {
    const tracked = this.orderLedger.get(orderId);
    if (tracked) {
      tracked.status = 'rejected';
      tracked.reason = reason;
      tracked.remainingShares = 0;
      tracked.updatedAtMs = Date.now();
      this.ledgerVersion += 1;
    }
    for (const [key, order] of this.live) {
      const ids = [order.orderId, ...(order.replenishOrderIds ?? [])];
      if (ids.includes(orderId)) this.live.delete(key);
    }
  }

  /** Cold-path snapshot; called by the cached status timer, never per book. */
  ordersSnapshot() {
    return [...this.orderLedger.values()]
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .map((order) => ({ ...order }));
  }

  async cancelAll() {
    if (this.busy) {
      await new Promise((resolve) => this.idleWaiters.push(resolve));
    }
    const orders = [...this.live.values()];
    await Promise.all(orders.map((o) => this.#cancel(o)));
  }

  async cancelLeg(leg) {
    if (this.busy) {
      await new Promise((resolve) => this.idleWaiters.push(resolve));
    }
    const orders = [...this.live.values()].filter(
      (order) => order.leg === leg
    );
    await Promise.all(orders.map((order) => this.#cancel(order)));
  }

  /**
   * One-shot profit-protect FAK buy. Does not enter the live rung map
   * (FAK never rests); still lands in the order ledger for the dashboard.
   * Live adapters may return filledShares from the CLOB postOrder response.
   */
  async placeProtectionFak({ leg, mils, shares, tokenId }) {
    if (!tokenId) {
      throw new Error(`placeProtectionFak: no tokenId for ${leg}`);
    }
    const size = roundShares(shares);
    const minimumShares = minimumOrderSharesForParams(mils, this.params);
    if (size < minimumShares) {
      throw new Error(
        `placeProtectionFak: size ${size} lower than minimum ` +
          `${minimumShares} at $${toProb(mils)}`
      );
    }
    const price = toProb(mils);
    try {
      const res = await this.exchange.placeLimitBuy({
        tokenId,
        price,
        size,
        roundSlug: this.roundSlug,
        protection: true,
        postOnly: false,
        orderType: 'FAK',
      });
      this.stats.placed += 1;
      const filledShares = roundShares(
        Math.max(0, Number(res.filledShares) || 0)
      );
      const remainingShares = roundShares(Math.max(0, size - filledShares));
      const avgPrice =
        Number.isFinite(Number(res.avgPrice)) && Number(res.avgPrice) > 0
          ? Number(res.avgPrice)
          : price;
      // Ledger starts unsettled; autoBalance/onFill applies confirmed size once.
      // mils stays the limit (e.g. FAK walk-cap 990); avgFillMils is set from fills.
      this.orderLedger.set(res.orderId, {
        orderId: res.orderId,
        roundId: this.roundSlug,
        leg,
        side: 'BUY',
        mils,
        price: toProb(mils),
        avgFillMils: null,
        originalShares: size,
        filledShares: 0,
        remainingShares: size,
        status: 'resting',
        replenish: false,
        protection: true,
        orderType: 'FAK',
        role: null,
        feeUsd: 0,
        placedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      this.ledgerVersion += 1;
      this.recorder.record(
        ev.orderPlaced(this.roundSlug, this.secOf(), {
          leg,
          mils,
          shares: size,
          offsetTicks: null,
          orderId: res.orderId,
          replenish: false,
          protection: true,
          orderType: 'FAK',
        })
      );
      return {
        orderId: res.orderId,
        leg,
        mils,
        shares: size,
        price: avgPrice,
        filledShares,
        remainingShares,
        avgPrice,
        status: res.status ?? null,
      };
    } catch (err) {
      this.stats.placeErrors += 1;
      const rejectedId = `rejected-${++this.rejectedSeq}`;
      this.orderLedger.set(rejectedId, {
        orderId: rejectedId,
        roundId: this.roundSlug,
        leg,
        side: 'BUY',
        mils,
        price,
        avgFillMils: null,
        originalShares: size,
        filledShares: 0,
        remainingShares: 0,
        status: 'rejected',
        reason: err.message,
        protection: true,
        orderType: 'FAK',
        role: null,
        feeUsd: 0,
        placedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      this.ledgerVersion += 1;
      this.recorder.record(
        ev.orderRejected(this.roundSlug, this.secOf(), {
          leg,
          mils,
          shares: size,
          reason: err.message,
        })
      );
      throw err;
    }
  }

  /** Cancel-to-fill ratio; his implied value is roughly 9:1. */
  get churnRatio() {
    const fills = this.stats.filledShares / this.params.RUNG_SHARES;
    return fills > 0 ? this.stats.cancelled / fills : Infinity;
  }
}
