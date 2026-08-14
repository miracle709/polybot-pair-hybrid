import { PARAMS } from './config.js';
import { roundAccounting } from './util.js';

const EPSILON = 1e-9;

function requireNonNegative(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return number;
}

/** Conservative per-share fee reserve for a notional-bps fee schedule. */
export function feeMilsPerShareFromBps(priceMils, feeBps) {
  const price = requireNonNegative('priceMils', priceMils);
  const bps = requireNonNegative('feeBps', feeBps);
  return Math.ceil((price * bps) / 10_000 - EPSILON);
}

/** Conservative per-share reserve for Polymarket's crypto taker curve. */
export function takerFeeMilsPerShare(priceMils, feeRate) {
  const price = requireNonNegative('priceMils', priceMils);
  const rate = requireNonNegative('feeRate', feeRate);
  if (price <= 0 || price >= 1000 || rate === 0) return 0;
  const probability = price / 1000;
  return Math.ceil(rate * probability * (1 - probability) * 1000 - EPSILON);
}

function feeAt(expectedFeeMils, candidateMils, lot) {
  const value =
    typeof expectedFeeMils === 'function'
      ? expectedFeeMils(candidateMils, lot)
      : expectedFeeMils;
  return requireNonNegative('expectedFeeMils', value ?? 0);
}

/** Maximum opposite-leg price for one immutable unmatched lot. */
export function complementCapForLot(
  lot,
  {
    pairTargetMils = PARAMS.PAIR_TARGET_MILS,
    executionBufferMils = PARAMS.PAIR_EXECUTION_BUFFER_MILS,
    expectedFeeMils = 0,
  } = {}
) {
  if (!lot || !(Number(lot.remainingShares) > 0)) return null;
  const target = requireNonNegative('pairTargetMils', pairTargetMils);
  const buffer = requireNonNegative(
    'executionBufferMils',
    executionBufferMils
  );
  const acquisition = requireNonNegative('lot.priceMils', lot.priceMils);

  if (typeof expectedFeeMils !== 'function') {
    return Math.floor(target - acquisition - buffer - feeAt(expectedFeeMils));
  }

  // Fee schedules such as the taker curve depend on the execution price.
  // Search the finite mil grid so the returned integer is authoritative.
  for (let candidate = 999; candidate >= 1; candidate -= 1) {
    if (
      acquisition +
        candidate +
        buffer +
        feeAt(expectedFeeMils, candidate, lot) <=
      target + EPSILON
    ) {
      return candidate;
    }
  }
  return 0;
}

/** FIFO lot slices that a proposed opposite-leg fill would complete. */
export function completionSlices(unmatchedLots, proposedShares) {
  let remaining = requireNonNegative('proposedShares', proposedShares);
  const slices = [];
  for (const lot of unmatchedLots ?? []) {
    if (remaining <= EPSILON) break;
    const lotShares = requireNonNegative(
      'lot.remainingShares',
      lot?.remainingShares ?? 0
    );
    if (lotShares <= EPSILON) continue;
    const shares = roundAccounting(Math.min(remaining, lotShares));
    slices.push({ lot, shares });
    remaining = roundAccounting(remaining - shares);
  }
  return {
    slices,
    completionShares: roundAccounting(
      slices.reduce((sum, slice) => sum + slice.shares, 0)
    ),
    unmatchedRemainder: roundAccounting(Math.max(0, remaining)),
  };
}

/**
 * Maximum single limit price for a proposed complementary fill.
 * The minimum individual lot cap is used deliberately; weighted averaging
 * would let a cheap lot donate edge to an expensive lot.
 */
export function maximumComplementPrice({
  unmatchedLots,
  proposedShares,
  pairTargetMils = PARAMS.PAIR_TARGET_MILS,
  executionBufferMils = PARAMS.PAIR_EXECUTION_BUFFER_MILS,
  expectedFeeMils = 0,
}) {
  const completion = completionSlices(unmatchedLots, proposedShares);
  const caps = completion.slices.map(({ lot, shares }) => ({
    lotId: lot.id,
    shares,
    capMils: complementCapForLot(lot, {
      pairTargetMils,
      executionBufferMils,
      expectedFeeMils,
    }),
  }));
  return {
    ...completion,
    capMils: caps.length ? Math.min(...caps.map((row) => row.capMils)) : null,
    lotCaps: caps,
  };
}

/** Whether an execution price satisfies both target and absolute hard cap. */
export function isPairCompletionEconomic({
  lot,
  oppositeMils,
  pairTargetMils = PARAMS.PAIR_TARGET_MILS,
  executionBufferMils = PARAMS.PAIR_EXECUTION_BUFFER_MILS,
  expectedFeeMils = 0,
  hardMaxMils = PARAMS.PAIR_HARD_MAX_MILS,
  allowNegativePairLock = PARAMS.ALLOW_NEGATIVE_PAIR_LOCK,
}) {
  const capMils = complementCapForLot(lot, {
    pairTargetMils,
    executionBufferMils,
    expectedFeeMils,
  });
  const pairMils = Number(lot?.priceMils) + Number(oppositeMils);
  return {
    accepted:
      Number(oppositeMils) <= capMils &&
      (allowNegativePairLock || pairMils <= Number(hardMaxMils)),
    capMils,
    pairMils,
  };
}
