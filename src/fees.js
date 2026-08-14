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
