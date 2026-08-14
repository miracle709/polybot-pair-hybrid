import {
  otherLeg,
  roundAccounting,
  notionalUsd,
  toCentsDisplay,
} from './util.js';

/**
 * Position state for one round.
 *
 * The bot never sells, so aggregate accounting is append-only until
 * settlement. V2 additionally freezes the marginal economics of every
 * completed UP/DOWN pair instead of treating global average cost as control.
 */
export class RoundInventory {
  constructor(roundSlug, windowStartEpoch) {
    this.roundSlug = roundSlug;
    this.windowStartEpoch = windowStartEpoch;
    this.legs = {
      UP: { shares: 0, costUsd: 0, fills: 0 },
      DOWN: { shares: 0, costUsd: 0, fills: 0 },
    };
    this.fills = [];
    this.lots = [];
    this.unmatchedUpLots = [];
    this.unmatchedDownLots = [];
    this.completedPairs = [];
    this.nextLotSequence = 1;
    this.restoredFillCount = 0;
  }

  /**
   * @param {'UP'|'DOWN'} leg
   * @param {number} mils integer limit price the fill executed at
   * @param {number} shares
   * @param {number} ts epoch seconds
   * @param {Object} [details]
   * @param {number} [details.feeUsd]
   * @param {string} [details.orderId]
   * @param {string} [details.id]
   */
  addFill(leg, mils, shares, ts, details = {}) {
    if (shares <= 0) return;
    const l = this.legs[leg];
    if (!l) throw new RangeError(`addFill: unknown leg ${leg}`);
    const priceMils = Number(mils);
    if (!Number.isFinite(priceMils) || priceMils < 0 || priceMils > 1000) {
      throw new RangeError(`addFill: invalid price ${mils}`);
    }
    const quantity = roundAccounting(Number(shares));
    const feeUsd = roundAccounting(
      Math.max(0, Number(details?.feeUsd ?? details?.fee ?? 0) || 0)
    );
    const sequence = this.nextLotSequence++;
    const lot = Object.freeze({
      id: details?.id ?? `${this.roundSlug}:lot-${sequence}`,
      leg,
      shares: quantity,
      priceMils,
      // Compatibility alias retained for existing replay/log consumers.
      mils: priceMils,
      remainingShares: quantity,
      feeUsd,
      ts: Number(ts),
      orderId: details?.orderId ?? null,
    });
    l.shares = roundAccounting(l.shares + shares);
    l.costUsd = roundAccounting(l.costUsd + notionalUsd(shares, priceMils));
    l.fills += 1;
    l.lastMils = priceMils;
    l.lastFillShares = shares;
    l.lastFillTs = ts;
    this.fills.push(lot);
    this.lots.push(lot);
    this.#matchLot(lot);
    return lot;
  }

  restoreLots(lots) {
    if (this.totalShares() > 0 || this.lots.length > 0) {
      throw new Error(`restoreLots: inventory ${this.roundSlug} is not empty`);
    }
    for (const lot of lots ?? []) {
      this.addFill(
        lot.leg,
        lot.priceMils ?? lot.mils,
        lot.shares,
        lot.ts,
        {
          id: lot.id,
          feeUsd: lot.feeUsd,
          orderId: lot.orderId,
        }
      );
    }
    return this;
  }

  accountingSnapshot() {
    return {
      version: 2,
      lots: this.lots.map((lot) => ({ ...lot })),
      completedPairs: this.completedPairs.map((pair) => ({ ...pair })),
    };
  }

  #unmatched(leg) {
    return leg === 'UP' ? this.unmatchedUpLots : this.unmatchedDownLots;
  }

  #replaceRemaining(queue, index, lot, remainingShares) {
    if (remainingShares <= 0) {
      queue.splice(index, 1);
      return;
    }
    queue[index] = Object.freeze({
      ...lot,
      remainingShares: roundAccounting(remainingShares),
    });
  }

  #matchLot(newLot) {
    const sameSide = this.#unmatched(newLot.leg);
    const oppositeSide = this.#unmatched(otherLeg(newLot.leg));
    let remaining = newLot.remainingShares;

    while (remaining > 0 && oppositeSide.length > 0) {
      const opposite = oppositeSide[0];
      const matched = roundAccounting(
        Math.min(remaining, opposite.remainingShares)
      );
      const upLot = newLot.leg === 'UP' ? newLot : opposite;
      const downLot = newLot.leg === 'DOWN' ? newLot : opposite;
      const pairMils = upLot.priceMils + downLot.priceMils;
      this.completedPairs.push(
        Object.freeze({
          upLotId: upLot.id,
          downLotId: downLot.id,
          shares: matched,
          upMils: upLot.priceMils,
          downMils: downLot.priceMils,
          pairMils,
          grossEdgeMils: 1000 - pairMils,
          completedAt: newLot.ts,
        })
      );
      remaining = roundAccounting(remaining - matched);
      this.#replaceRemaining(
        oppositeSide,
        0,
        opposite,
        opposite.remainingShares - matched
      );
    }

    if (remaining > 0) {
      sameSide.push(
        remaining === newLot.remainingShares
          ? newLot
          : Object.freeze({ ...newLot, remainingShares: remaining })
      );
    }
  }

  shares(leg) {
    return this.legs[leg].shares;
  }

  costUsd(leg) {
    return this.legs[leg].costUsd;
  }

  /** Average cost of a leg, in mils. null if the leg is empty. */
  avgMils(leg) {
    const l = this.legs[leg];
    return l.shares > 0 ? (l.costUsd / l.shares) * 1000 : null;
  }

  /**
   * avgUp + avgDown, in mils. Below 1000 means every matched share is
   * profitable at settlement. His realized median is 991.9 mils (99.19c) across all
   * 1,473 rounds — roughly 0.8c per pair, against a 1c theoretical floor.
   */
  pairCostMils() {
    const u = this.avgMils('UP');
    const d = this.avgMils('DOWN');
    return u === null || d === null ? null : u + d;
  }

  /** Shares that are hedged. These are the risk-free part of the book. */
  matchedShares() {
    return Math.min(this.legs.UP.shares, this.legs.DOWN.shares);
  }

  /** Signed, positive = long UP. This is the only directional exposure. */
  tiltShares() {
    return roundAccounting(this.legs.UP.shares - this.legs.DOWN.shares);
  }

  /** |tilt| as a fraction of total shares. */
  tiltFraction() {
    const total = this.legs.UP.shares + this.legs.DOWN.shares;
    return total === 0 ? 0 : Math.abs(this.tiltShares()) / total;
  }

  /** How far this leg is BEHIND the other, in shares. */
  lagOf(leg) {
    return roundAccounting(
      this.legs[otherLeg(leg)].shares - this.legs[leg].shares
    );
  }

  totalNotionalUsd() {
    return roundAccounting(this.legs.UP.costUsd + this.legs.DOWN.costUsd);
  }

  totalShares() {
    return roundAccounting(this.legs.UP.shares + this.legs.DOWN.shares);
  }

  totalFeeUsd() {
    return roundAccounting(
      this.lots.reduce((sum, lot) => sum + lot.feeUsd, 0)
    );
  }

  #feeUsd(feeUsd) {
    if (feeUsd === undefined) return this.totalFeeUsd();
    return roundAccounting(Math.max(0, Number(feeUsd) || 0));
  }

  pnlIfUpWins(feeUsd) {
    return roundAccounting(
      this.shares('UP') - this.totalNotionalUsd() - this.#feeUsd(feeUsd)
    );
  }

  pnlIfDownWins(feeUsd) {
    return roundAccounting(
      this.shares('DOWN') - this.totalNotionalUsd() - this.#feeUsd(feeUsd)
    );
  }

  worstCasePnl(feeUsd) {
    return Math.min(this.pnlIfUpWins(feeUsd), this.pnlIfDownWins(feeUsd));
  }

  /** Guaranteed settlement lower bound for the current complete position. */
  guaranteedPnl(feeUsd) {
    return this.worstCasePnl(feeUsd);
  }

  /** Gross edge frozen at pair completion; fill fees remain separate. */
  completedPairEdgeUsd() {
    return roundAccounting(
      this.completedPairs.reduce(
        (sum, pair) => sum + (pair.shares * pair.grossEdgeMils) / 1000,
        0
      )
    );
  }

  completedPairAverageMils() {
    const shares = this.completedPairs.reduce(
      (sum, pair) => sum + pair.shares,
      0
    );
    if (shares <= 0) return null;
    return (
      this.completedPairs.reduce(
        (sum, pair) => sum + pair.shares * pair.pairMils,
        0
      ) / shares
    );
  }

  unmatchedShares(leg) {
    if (!this.legs[leg]) {
      throw new RangeError(`unmatchedShares: unknown leg ${leg}`);
    }
    return roundAccounting(
      this.#unmatched(leg).reduce(
        (sum, lot) => sum + lot.remainingShares,
        0
      )
    );
  }

  oldestUnmatchedAgeSeconds(now) {
    const lots = [...this.unmatchedUpLots, ...this.unmatchedDownLots];
    if (!lots.length) return 0;
    const oldestTs = Math.min(...lots.map((lot) => lot.ts));
    return Math.max(0, Number(now) - oldestTs);
  }

  fillCount() {
    return this.restoredFillCount + this.fills.length;
  }

  /**
   * Economic liquidation mark for a binary CTF position. Every matched
   * UP/DOWN pair is a complete set worth exactly $1; only the unmatched tilt
   * needs to be marked at an executable bid.
   */
  markValueUsd(upBidMils, downBidMils) {
    if (upBidMils == null || downBidMils == null) return null;
    const tilt = this.tiltShares();
    return (
      this.matchedShares() +
      (tilt > 0 ? (tilt * upBidMils) / 1000 : 0) +
      (tilt < 0 ? (-tilt * downBidMils) / 1000 : 0)
    );
  }

  /**
   * Exact resolution value for either possible winner. Losing shares redeem
   * for $0 and winning shares redeem for $1 each.
   */
  outcomeValue(winner, feeUsd = 0) {
    if (!this.legs[winner]) {
      throw new RangeError(`outcomeValue: unknown winner ${winner}`);
    }
    const payoutUsd = roundAccounting(this.legs[winner].shares);
    const costUsd = this.totalNotionalUsd();
    const investedUsd = roundAccounting(
      costUsd + Math.max(0, Number(feeUsd) || 0)
    );
    const pnlUsd = roundAccounting(payoutUsd - investedUsd);
    return {
      winner,
      payoutUsd,
      costUsd,
      feeUsd: roundAccounting(Math.max(0, Number(feeUsd) || 0)),
      investedUsd,
      pnlUsd,
      roi: investedUsd > 0 ? pnlUsd / investedUsd : 0,
    };
  }

  /**
   * Settlement PnL. A winning share redeems for exactly $1.00.
   * @param {'UP'|'DOWN'} winner
   */
  settle(winner) {
    const outcome = this.outcomeValue(winner);
    return {
      roundSlug: this.roundSlug,
      winner,
      payoutUsd: outcome.payoutUsd,
      costUsd: outcome.costUsd,
      pnlUsd: outcome.pnlUsd,
      matchedShares: this.matchedShares(),
      tiltShares: this.tiltShares(),
      pairCostMils: this.pairCostMils(),
      pairCostCentsDisplay: this.pairCostMils() === null ? null : toCentsDisplay(this.pairCostMils()),
      fills: this.fillCount(),
    };
  }

  snapshot() {
    return {
      roundSlug: this.roundSlug,
      up: { ...this.legs.UP, avgMils: this.avgMils('UP') },
      down: { ...this.legs.DOWN, avgMils: this.avgMils('DOWN') },
      pairCostMils: this.pairCostMils(),
      pairCostCentsDisplay: this.pairCostMils() === null ? null : toCentsDisplay(this.pairCostMils()),
      matched: this.matchedShares(),
      tilt: this.tiltShares(),
      tiltFraction: this.tiltFraction(),
      notionalUsd: this.totalNotionalUsd(),
      unmatchedUp: this.unmatchedShares('UP'),
      unmatchedDown: this.unmatchedShares('DOWN'),
      completedPairCount: this.completedPairs.length,
      completedPairAverageMils: this.completedPairAverageMils(),
      completedPairEdgeUsd: this.completedPairEdgeUsd(),
      pnlIfUpWins: this.pnlIfUpWins(),
      pnlIfDownWins: this.pnlIfDownWins(),
      worstCasePnl: this.worstCasePnl(),
      guaranteedPnl: this.guaranteedPnl(),
    };
  }
}
