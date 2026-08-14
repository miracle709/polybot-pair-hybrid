export const FIXED_HORIZONS_MS = Object.freeze([1000, 3000, 5000, 10_000]);

export function fixedHorizonReturns(buffer, decisionTimeMs) {
  const output = {};
  for (const horizonMs of FIXED_HORIZONS_MS) {
    const result = buffer.fixedHorizonLogReturnBps(decisionTimeMs, horizonMs);
    output[horizonMs / 1000] = result;
  }
  return Object.freeze(output);
}

