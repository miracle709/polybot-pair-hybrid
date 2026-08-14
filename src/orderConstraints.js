import { roundShares } from './util.js';

/** Polymarket applies both constraints to every submitted order. */
export const POLYMARKET_MIN_ORDER_SHARES = 5;
export const POLYMARKET_MIN_ORDER_NOTIONAL_USD = 1;

/**
 * Smallest step-aligned size that satisfies both the share and USD minimums.
 * Prices use the bot's integer-mil representation (100 mils = $0.10).
 */
export function minimumOrderSharesAtMils(
  mils,
  {
    minimumShares = POLYMARKET_MIN_ORDER_SHARES,
    minimumNotionalUsd = POLYMARKET_MIN_ORDER_NOTIONAL_USD,
    stepShares = 1,
  } = {}
) {
  if (!Number.isInteger(mils) || mils <= 0) {
    throw new RangeError(`minimumOrderSharesAtMils: invalid mils ${mils}`);
  }
  if (!(Number(stepShares) > 0)) {
    throw new RangeError(
      `minimumOrderSharesAtMils: invalid share step ${stepShares}`
    );
  }

  const step = Number(stepShares);
  const notionalMinimum = (Number(minimumNotionalUsd) * 1000) / mils;
  const rawMinimum = Math.max(Number(minimumShares), notionalMinimum);
  // Remove only floating-point noise at exact boundaries such as 1 / 0.10.
  return roundShares(Math.ceil(rawMinimum / step - 1e-12) * step);
}

export function minimumOrderSharesForParams(mils, params = {}) {
  return minimumOrderSharesAtMils(mils, {
    minimumShares: Math.max(
      POLYMARKET_MIN_ORDER_SHARES,
      params.MIN_RUNG_SHARES ?? POLYMARKET_MIN_ORDER_SHARES
    ),
    minimumNotionalUsd: Math.max(
      POLYMARKET_MIN_ORDER_NOTIONAL_USD,
      params.MIN_ORDER_NOTIONAL_USD ??
        POLYMARKET_MIN_ORDER_NOTIONAL_USD
    ),
    stepShares: params.RUNG_SIZE_STEP_SHARES ?? 1,
  });
}

export function orderNotionalMeetsMinimum(
  shares,
  mils,
  minimumNotionalUsd = POLYMARKET_MIN_ORDER_NOTIONAL_USD
) {
  return (
    Number(shares) * Number(mils) + 1e-9 >=
    Number(minimumNotionalUsd) * 1000
  );
}
