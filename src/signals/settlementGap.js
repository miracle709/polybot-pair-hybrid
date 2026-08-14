function positive(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
  return number;
}

export function settlementGap({ settlementReferencePrice, priceToBeat }) {
  const spot = positive('settlementReferencePrice', settlementReferencePrice);
  const strike = positive('priceToBeat', priceToBeat);
  return Object.freeze({
    rawGapBps: 10_000 * ((spot - strike) / strike),
    logGapBps: 10_000 * Math.log(spot / strike),
  });
}

export function twapGapBps({ twapPrice, priceToBeat }) {
  const twap = positive('twapPrice', twapPrice);
  const strike = positive('priceToBeat', priceToBeat);
  return 10_000 * ((twap - strike) / strike);
}

/** Telemetry-only compatibility feature. Never authorizes capital. */
export function legacyGapDirection(rawGapBps) {
  const gap = Number(rawGapBps);
  if (!Number.isFinite(gap)) return 'NEUTRAL';
  if (gap > 1) return 'UP';
  if (gap < -1) return 'DOWN';
  return 'NEUTRAL';
}

