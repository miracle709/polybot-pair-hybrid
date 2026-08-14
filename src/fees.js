/**
 * Polymarket crypto taker fee curve:
 *   fee = shares × feeRate × price × (1 − price)
 * Maker fee is always 0 (not computed here).
 *
 * Rounding matches the live user-feed path (1e5).
 *
 * @param {number} shares
 * @param {number} price probability in (0, 1)
 * @param {number} feeRate e.g. 0.07 (= 700 bps of price×(1−price)×size)
 * @returns {number}
 */
export function cryptoTakerFeeUsd(shares, price, feeRate) {
  const size = Number(shares);
  const p = Number(price);
  const rate = Number(feeRate);
  if (
    !Number.isFinite(size) ||
    size <= 0 ||
    !Number.isFinite(p) ||
    p <= 0 ||
    p >= 1 ||
    !Number.isFinite(rate) ||
    rate < 0
  ) {
    return 0;
  }
  return Math.round(size * rate * p * (1 - p) * 1e5) / 1e5;
}

/** Execution venue role used by marginal-action economics. */
export const ExecutionType = Object.freeze({
  MAKER: 'MAKER',
  TAKER: 'TAKER',
});

function requirePositive(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
  return number;
}

function requirePrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new RangeError('price must be in (0, 1)');
  }
  return price;
}

function requireNonNegative(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError(`${name} must be non-negative`);
  }
  return number;
}

function roundFee(value) {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * Canonical fee for one proposed execution. Historical portfolio fees are not
 * accepted here, which prevents them from being charged again in marginal EV.
 *
 * Maker cost is not assumed: makerBps must be supplied for maker actions.
 * Taker cost retains the venue's nonlinear crypto curve. A separately
 * configured builder fee is assessed once on executed notional for either role.
 */
export function executionFeeUsd({
  executionType,
  shares,
  price,
  makerBps,
  takerFeeRate,
  builderFeeBps = 0,
}) {
  const size = requirePositive('shares', shares);
  const p = requirePrice(price);
  const builderBps = requireNonNegative('builderFeeBps', builderFeeBps);
  const builderFee = size * p * (builderBps / 10_000);

  if (executionType === ExecutionType.MAKER) {
    const bps = requireNonNegative('makerBps', makerBps);
    return roundFee(size * p * (bps / 10_000) + builderFee);
  }
  if (executionType === ExecutionType.TAKER) {
    const rate = requireNonNegative('takerFeeRate', takerFeeRate);
    return roundFee(size * rate * p * (1 - p) + builderFee);
  }
  throw new RangeError(`unknown execution type ${executionType}`);
}
