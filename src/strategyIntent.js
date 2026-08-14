/** Decision provenance. Intent never changes physical FIFO matching. */
export const StrategyIntent = Object.freeze({
  PAIR_OPEN: 'PAIR_OPEN',
  PAIR_COMPLETE: 'PAIR_COMPLETE',
  DIRECTIONAL: 'DIRECTIONAL',
  RISK_REDUCTION: 'RISK_REDUCTION',
  PROTECTION: 'PROTECTION',
});

const VALUES = new Set(Object.values(StrategyIntent));

export function isStrategyIntent(value) {
  return VALUES.has(value);
}

export function requireStrategyIntent(value, fallback = null) {
  const intent = value ?? fallback;
  if (!isStrategyIntent(intent)) {
    throw new RangeError(`unknown strategy intent ${intent}`);
  }
  return intent;
}

