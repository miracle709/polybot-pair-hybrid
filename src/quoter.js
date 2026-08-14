import { PARAMS, GUARDS, MARKET } from './config.js';
import { feeMilsPerShareFromBps, maximumComplementPrice } from './pairEconomics.js';
import { minimumOrderSharesForParams } from './orderConstraints.js';
import { notionalUsd, otherLeg, rungKey, stepTicks, tickSizeMils } from './util.js';

/**
 * The entire decision surface of the strategy.
 *
 * Pure: given the clock, both books, and the round's inventory, return the
 * exact set of resting buy orders that SHOULD be live right now. The order
 * manager diffs this against what IS live.
 *
 * Everything the target wallet does is in here, and it is genuinely this
 * small. There is no signal, no forecast, no cost-basis feedback, no
 * volatility term. Two gates and an offset.
 */

export const SuppressReason = {
  CLOCK_BEFORE_GATE: 'clock_before_gate',
  CLOCK_AFTER_STOP: 'clock_after_stop',
  BOOK_UNUSABLE: 'book_unusable',
  BAND_GATE: 'band_gate',
  LIMIT_CLAMP: 'limit_clamp',
  INSUFFICIENT_DEPTH: 'insufficient_depth',
  LEG_SHARE_CAP: 'leg_share_cap',
  ROUND_NOTIONAL_CAP: 'round_notional_cap',
  TILT_LIMIT: 'tilt_limit',
  PAIR_PRICE_CAP: 'pair_price_cap',
  AHEAD_LEG: 'ahead_leg',
  PAIR_CYCLE_CLOSED: 'pair_cycle_closed',
  LATE_NEW_CYCLE: 'late_new_cycle',
  UNMATCHED_SHARE_CAP: 'unmatched_share_cap',
  UNMATCHED_AGE: 'unmatched_age',
  HEDGE_NOT_ECONOMIC: 'hedge_not_economic',
  PAIR_HARD_MAX: 'pair_hard_max',
  UNMATCHED_BOTH_SIDES: 'unmatched_both_sides',
};

export const PairRegime = Object.freeze({
  WARMUP: 'WARMUP',
  DISCOVERY: 'DISCOVERY',
  ACCUMULATION: 'ACCUMULATION',
  COMPLETION: 'COMPLETION',
  RISK_REDUCTION: 'RISK_REDUCTION',
  CLOSE_ONLY: 'CLOSE_ONLY',
  CLOSED: 'CLOSED',
});

export const PairCycleState = Object.freeze({
  NEUTRAL: 'NEUTRAL',
  WAITING_FOR_COMPLEMENT: 'WAITING_FOR_COMPLEMENT',
  PAUSED: 'PAUSED',
});

export function roundRegime(secondsIntoRound, params = PARAMS) {
  const t = Number(secondsIntoRound);
  if (t < params.PAIR_DISCOVERY_START_SECONDS) return PairRegime.WARMUP;
  if (t < params.PAIR_ACCUMULATION_START_SECONDS) return PairRegime.DISCOVERY;
  if (t < params.PAIR_ACCUMULATION_END_SECONDS) return PairRegime.ACCUMULATION;
  if (t < params.PAIR_COMPLETION_END_SECONDS) return PairRegime.COMPLETION;
  if (t < params.PAIR_RISK_REDUCTION_END_SECONDS) {
    return PairRegime.RISK_REDUCTION;
  }
  if (t < params.QUOTE_STOP_SECONDS) return PairRegime.CLOSE_ONLY;
  return PairRegime.CLOSED;
}

export function pairCycleState(inventory, paused = false) {
  if (paused) return PairCycleState.PAUSED;
  return inventory.unmatchedShares('UP') > 0 ||
    inventory.unmatchedShares('DOWN') > 0
    ? PairCycleState.WAITING_FOR_COMPLEMENT
    : PairCycleState.NEUTRAL;
}

export function checkEconomicInvariants(inventory, params = PARAMS, now = null) {
  const breaches = [];
  if (!params.ALLOW_NEGATIVE_PAIR_LOCK) {
    for (const pair of inventory.completedPairs ?? []) {
      if (pair.pairMils > params.PAIR_HARD_MAX_MILS) {
        breaches.push({
          reason: SuppressReason.PAIR_HARD_MAX,
          pairMils: pair.pairMils,
          hardMaxMils: params.PAIR_HARD_MAX_MILS,
          upLotId: pair.upLotId,
          downLotId: pair.downLotId,
        });
      }
    }
  }
  const unmatchedUp = inventory.unmatchedShares('UP');
  const unmatchedDown = inventory.unmatchedShares('DOWN');
  for (const [leg, shares] of [
    ['UP', unmatchedUp],
    ['DOWN', unmatchedDown],
  ]) {
    if (shares > params.MAX_UNMATCHED_SHARES) {
      breaches.push({
        leg,
        reason: SuppressReason.UNMATCHED_SHARE_CAP,
        shares,
        maxShares: params.MAX_UNMATCHED_SHARES,
      });
    }
  }
  if (unmatchedUp > 0 && unmatchedDown > 0) {
    breaches.push({
      reason: SuppressReason.UNMATCHED_BOTH_SIDES,
      unmatchedUp,
      unmatchedDown,
    });
  }
  if (now != null && unmatchedUp + unmatchedDown > 0) {
    const ageSeconds = inventory.oldestUnmatchedAgeSeconds(now);
    if (ageSeconds > params.MAX_UNMATCHED_AGE_SECONDS) {
      breaches.push({
        reason: SuppressReason.UNMATCHED_AGE,
        ageSeconds,
        maxAgeSeconds: params.MAX_UNMATCHED_AGE_SECONDS,
      });
    }
  }
  return breaches;
}

export function computeRungShares({
  book,
  inventory,
  params = PARAMS,
  guards = GUARDS,
}) {
  if (!params.DYNAMIC_SIZING_ENABLED) return params.RUNG_SHARES;
  let raw =
    params.RUNG_DEPTH_FRACTION *
    book.bidDepthWithin(params.DEPTH_SIZING_TICKS);
  if (
    inventory.totalNotionalUsd() >= guards.MAX_ROUND_NOTIONAL_USD.softLimit
  ) {
    // Soft threshold reduces clip size above ROUND_SOFT_CAP.
    raw *= 0.5;
  }
  const capped = Math.min(
    raw,
    params.MAX_LEG_SHARES ?? params.MAX_RUNG_SHARES
  );
  const step = params.RUNG_SIZE_STEP_SHARES;
  const quantized = Math.floor(capped / step) * step;
  return quantized >= params.MIN_RUNG_SHARES ? quantized : 0;
}

function allocateLegShares(candidates, targetShares, params) {
  const step = params.RUNG_SIZE_STEP_SHARES;
  const minimumByRung = candidates.map((rung) =>
    minimumOrderSharesForParams(rung.mils, params)
  );
  const allocation = candidates.map(() => 0);
  let remaining = Math.floor(targetShares / step) * step;

  // Open a rung only with a full venue-legal grant. At $0.10, for example,
  // the $1 order-notional floor consolidates a 10-share leg into one rung
  // instead of splitting it into two venue-rejected 5-share orders.
  for (let index = 0; index < candidates.length; index += 1) {
    const minimum = minimumByRung[index];
    const cap = Math.min(targetShares, params.MAX_RUNG_SHARES);
    if (minimum > cap) continue;
    if (remaining < minimum) break;
    allocation[index] = minimum;
    remaining -= minimum;
  }

  while (remaining >= step) {
    let selected = -1;
    for (let index = 0; index < candidates.length; index += 1) {
      const minimum = minimumByRung[index];
      if (allocation[index] < minimum) continue;
      const cap = Math.min(targetShares, params.MAX_RUNG_SHARES);
      if (
        allocation[index] + step <= cap &&
        (selected === -1 || allocation[index] < allocation[selected])
      ) {
        selected = index;
      }
    }
    if (selected === -1) break;
    allocation[selected] += step;
    remaining -= step;
  }

  return allocation;
}

function applyNotionalBudget(rungs, inventory, guards, params) {
  const hardLimit = guards.MAX_ROUND_NOTIONAL_USD.hardLimit ?? Infinity;
  const availableUsd = hardLimit - inventory.totalNotionalUsd();
  if (availableUsd <= 0) {
    return { rungs: [], availableUsd };
  }

  const desiredUsd = rungs.reduce(
    (total, rung) => total + notionalUsd(rung.shares, rung.mils),
    0
  );
  if (desiredUsd <= availableUsd) return { rungs, availableUsd };

  const scale = availableUsd / desiredUsd;
  const step = params.RUNG_SIZE_STEP_SHARES;
  const scaled = rungs
    .map((rung) => ({
      ...rung,
      shares: Math.floor((rung.shares * scale) / step) * step,
    }))
    .filter(
      (rung) =>
        rung.shares >= minimumOrderSharesForParams(rung.mils, params)
    );
  return { rungs: scaled, availableUsd };
}

function floorToVenueTick(mils) {
  const bounded = Math.max(1, Math.min(999, Math.floor(mils)));
  const tick = tickSizeMils(bounded);
  return Math.floor(bounded / tick) * tick;
}

function passiveCandidates({ leg, book, params, opening, capMils = null }) {
  const candidates = [];
  const seen = new Set();
  for (let index = 0; index < params.LADDER_LEVELS; index += 1) {
    const passiveMils = stepTicks(
      book.bestBid,
      -(params.BASE_OFFSET_TICKS + index)
    );
    const mils = floorToVenueTick(
      capMils == null ? passiveMils : Math.min(passiveMils, capMils)
    );
    const key = rungKey(leg, mils);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      leg,
      mils,
      offsetTicks: params.BASE_OFFSET_TICKS + index,
      opening,
      key,
      complementCapMils: capMils,
    });
  }
  return candidates;
}

/**
 * @typedef {Object} DesiredRung
 * @property {'UP'|'DOWN'} leg
 * @property {number} mils          integer limit price
 * @property {number} shares        target resting size
 * @property {number} offsetTicks   how far behind the bid this rung sits
 * @property {string} key
 */

/**
 * @param {Object} ctx
 * @param {number} ctx.secondsIntoRound
 * @param {import('./book.js').MarketBook} ctx.books
 * @param {import('./inventory.js').RoundInventory} ctx.inventory
 * @param {Object}  [ctx.params]
 * @param {Object}  [ctx.guards]
 * @returns {{rungs: DesiredRung[], suppressed: Array<{leg:string,reason:string,detail?:any}>}}
 */
export function computeDesiredRungs(ctx) {
  const P = ctx.params ?? PARAMS;
  const G = ctx.guards ?? GUARDS;
  const { secondsIntoRound: t, books, inventory } = ctx;

  const candidates = [];
  const suppressed = [];
  const drop = (leg, reason, detail) => suppressed.push({ leg, reason, detail });
  const regime = roundRegime(t, P);
  const now = inventory.windowStartEpoch + t;
  const invariantBreaches = checkEconomicInvariants(inventory, P, now);
  const hardPause = invariantBreaches.some(
    (breach) =>
      breach.reason === SuppressReason.PAIR_HARD_MAX ||
      breach.reason === SuppressReason.UNMATCHED_BOTH_SIDES
  );

  if (hardPause) {
    for (const breach of invariantBreaches) drop('*', breach.reason, breach);
    return {
      rungs: [],
      suppressed,
      regime,
      pairCycleState: PairCycleState.PAUSED,
      complementCapMils: null,
      invariantBreaches,
      pauseNewCycles: true,
    };
  }

  if (regime === PairRegime.WARMUP) {
    drop('*', SuppressReason.CLOCK_BEFORE_GATE, { t });
    return {
      rungs: [], suppressed, regime,
      pairCycleState: pairCycleState(inventory),
      complementCapMils: null,
      invariantBreaches,
      pauseNewCycles: true,
    };
  }
  if (regime === PairRegime.CLOSED) {
    drop('*', SuppressReason.CLOCK_AFTER_STOP, { t });
    return {
      rungs: [], suppressed, regime,
      pairCycleState: pairCycleState(inventory),
      complementCapMils: null,
      invariantBreaches,
      pauseNewCycles: true,
    };
  }

  const unmatchedUp = inventory.unmatchedShares('UP');
  const unmatchedDown = inventory.unmatchedShares('DOWN');
  const aheadLeg = unmatchedUp > 0 ? 'UP' : unmatchedDown > 0 ? 'DOWN' : null;
  const complementLeg = aheadLeg ? otherLeg(aheadLeg) : null;
  const pauseNewCycles =
    invariantBreaches.length > 0 || regime === PairRegime.CLOSE_ONLY;
  let complementCapMils = null;

  for (const breach of invariantBreaches) {
    drop(breach.leg ?? '*', breach.reason, breach);
  }

  if (aheadLeg) {
    drop(aheadLeg, SuppressReason.AHEAD_LEG, {
      unmatchedShares: inventory.unmatchedShares(aheadLeg),
    });
    const book = books[complementLeg];
    if (!book || !book.isUsable()) {
      drop(complementLeg, SuppressReason.BOOK_UNUSABLE);
    } else {
      const rawTarget = computeRungShares({
        book,
        inventory,
        params: P,
        guards: G,
      });
      const targetShares = Math.min(
        rawTarget,
        inventory.unmatchedShares(aheadLeg)
      );
      if (targetShares < P.MIN_RUNG_SHARES) {
        drop(complementLeg, SuppressReason.INSUFFICIENT_DEPTH, {
          targetShares,
          unmatchedShares: inventory.unmatchedShares(aheadLeg),
        });
      } else {
        const unmatchedLots =
          aheadLeg === 'UP'
            ? inventory.unmatchedUpLots
            : inventory.unmatchedDownLots;
        const economics = maximumComplementPrice({
          unmatchedLots,
          proposedShares: targetShares,
          pairTargetMils: P.PAIR_TARGET_MILS,
          executionBufferMils: P.PAIR_EXECUTION_BUFFER_MILS,
          expectedFeeMils: (priceMils) =>
            feeMilsPerShareFromBps(
              priceMils,
              P.ASSUMED_FEE_BPS_OF_NOTIONAL ?? 0
            ),
        });
        complementCapMils = economics.capMils;
        if (
          complementCapMils == null ||
          complementCapMils < P.MIN_LIMIT_MILS
        ) {
          drop(complementLeg, SuppressReason.PAIR_PRICE_CAP, {
            capMils: complementCapMils,
            targetShares,
            lotCaps: economics.lotCaps,
          });
        } else {
          const legCandidates = passiveCandidates({
            leg: complementLeg,
            book,
            params: P,
            opening: false,
            capMils: Math.min(complementCapMils, P.MAX_LIMIT_MILS),
          }).filter((rung) => rung.mils >= P.MIN_LIMIT_MILS);
          const sharesByRung = allocateLegShares(
            legCandidates,
            targetShares,
            P
          );
          for (let index = 0; index < legCandidates.length; index += 1) {
            if (
              sharesByRung[index] >=
              minimumOrderSharesForParams(legCandidates[index].mils, P)
            ) {
              candidates.push({
                ...legCandidates[index],
                shares: sharesByRung[index],
                pairCompletion: true,
              });
            }
          }
          if (!legCandidates.length || !candidates.length) {
            drop(complementLeg, SuppressReason.PAIR_PRICE_CAP, {
              capMils: complementCapMils,
              targetShares,
            });
          }
        }
      }
    }
  } else if (pauseNewCycles) {
    drop('*', SuppressReason.PAIR_CYCLE_CLOSED, { regime });
  } else {
    const lateNewCycle =
      regime === PairRegime.COMPLETION ||
      regime === PairRegime.RISK_REDUCTION;
    const opening = regime === PairRegime.DISCOVERY;

    for (const leg of MARKET.legs) {
      const book = books[leg];

      if (!book || !book.isUsable()) {
        drop(leg, SuppressReason.BOOK_UNUSABLE);
        continue;
      }

      const mid = book.midMils;
      if (mid < P.BAND_LOW_MILS || mid > P.BAND_HIGH_MILS) {
        drop(leg, SuppressReason.BAND_GATE, { mid });
        continue;
      }

      const legCandidates = passiveCandidates({
        leg,
        book,
        params: P,
        opening,
      });

      for (const { mils } of legCandidates) {
      if (mils < P.MIN_LIMIT_MILS || mils > P.MAX_LIMIT_MILS) {
        drop(leg, SuppressReason.LIMIT_CLAMP, { mils });
      }
      }
      const validCandidates = legCandidates.filter(
        ({ mils }) => mils >= P.MIN_LIMIT_MILS && mils <= P.MAX_LIMIT_MILS
      );

      const depthTargetShares = computeRungShares({
        book,
        inventory,
        params: P,
        guards: G,
      });
      let targetShares = Math.min(
        depthTargetShares,
        P.MAX_UNMATCHED_SHARES
      );
      if (opening) {
        targetShares = Math.min(targetShares, P.OPENING_MAX_RUNG_SHARES);
      }
      if (lateNewCycle) {
        targetShares = Math.min(targetShares, P.MIN_RUNG_SHARES);
        drop(leg, SuppressReason.LATE_NEW_CYCLE, { regime, targetShares });
      }
      if (targetShares <= 0) {
        for (const rung of validCandidates) {
          drop(leg, SuppressReason.INSUFFICIENT_DEPTH, { mils: rung.mils });
        }
        continue;
      }

      const sharesByRung = allocateLegShares(
        validCandidates,
        targetShares,
        P
      );
      for (let index = 0; index < validCandidates.length; index += 1) {
        const shares = sharesByRung[index];
        const minimumShares = minimumOrderSharesForParams(
          validCandidates[index].mils,
          P
        );
        if (shares < minimumShares) {
          drop(leg, SuppressReason.LEG_SHARE_CAP, {
            mils: validCandidates[index].mils,
            targetShares,
            minimumShares,
            minimumNotionalUsd: P.MIN_ORDER_NOTIONAL_USD,
          });
          continue;
        }
        candidates.push({ ...validCandidates[index], shares });
      }
    }

    const openingUp = candidates.filter((rung) => rung.leg === 'UP');
    const openingDown = candidates.filter((rung) => rung.leg === 'DOWN');
    if (!openingUp.length || !openingDown.length) {
      if (candidates.length) {
        drop('*', SuppressReason.PAIR_PRICE_CAP, {
          reason: 'neutral_cycle_requires_both_legs',
        });
      }
      candidates.length = 0;
    } else {
      const maxUpMils = Math.max(...openingUp.map((rung) => rung.mils));
      const maxDownMils = Math.max(...openingDown.map((rung) => rung.mils));
      const feeBps = P.ASSUMED_FEE_BPS_OF_NOTIONAL ?? 0;
      const expectedFeeMils =
        feeMilsPerShareFromBps(maxUpMils, feeBps) +
        feeMilsPerShareFromBps(maxDownMils, feeBps);
      const effectivePairMils =
        maxUpMils +
        maxDownMils +
        P.PAIR_EXECUTION_BUFFER_MILS +
        expectedFeeMils;
      if (
        effectivePairMils > P.PAIR_TARGET_MILS ||
        (!P.ALLOW_NEGATIVE_PAIR_LOCK &&
          maxUpMils + maxDownMils > P.PAIR_HARD_MAX_MILS)
      ) {
        drop('*', SuppressReason.PAIR_PRICE_CAP, {
          maxUpMils,
          maxDownMils,
          expectedFeeMils,
          executionBufferMils: P.PAIR_EXECUTION_BUFFER_MILS,
          effectivePairMils,
          targetMils: P.PAIR_TARGET_MILS,
        });
        candidates.length = 0;
      }
    }
  }

  const budgeted = applyNotionalBudget(candidates, inventory, G, P);
  if (budgeted.rungs.length < candidates.length) {
    const budgetedKeys = new Set(budgeted.rungs.map((rung) => rung.key));
    for (const rung of candidates) {
      if (!budgetedKeys.has(rung.key)) {
        drop(rung.leg, SuppressReason.ROUND_NOTIONAL_CAP, {
          mils: rung.mils,
          availableUsd: budgeted.availableUsd,
        });
      }
    }
  }

  let finalRungs = budgeted.rungs;
  if (
    !aheadLeg &&
    finalRungs.length > 0 &&
    (!finalRungs.some((rung) => rung.leg === 'UP') ||
      !finalRungs.some((rung) => rung.leg === 'DOWN'))
  ) {
    for (const rung of finalRungs) {
      drop(rung.leg, SuppressReason.ROUND_NOTIONAL_CAP, {
        reason: 'budget_cannot_fund_both_opening_legs',
      });
    }
    finalRungs = [];
  }

  return {
    rungs: finalRungs,
    suppressed,
    regime,
    pairCycleState: pairCycleState(inventory),
    complementCapMils,
    invariantBreaches,
    pauseNewCycles,
  };
}
