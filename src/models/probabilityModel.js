function clampProbability(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

export function probabilityPrediction({
  pUp,
  lower,
  upper,
  modelVersion,
  calibrated = false,
  valid = true,
  reasons = [],
}) {
  const rawP = Number(pUp);
  const rawLower = Number(lower);
  const rawUpper = Number(upper);
  const p = clampProbability(pUp);
  const lo = clampProbability(lower);
  const hi = clampProbability(upper);
  const validationFailures = [];
  if (p == null || lo == null || hi == null) validationFailures.push('non_finite_probability');
  if (
    Number.isFinite(rawP) &&
    (rawP < 0 || rawP > 1 || rawLower < 0 || rawLower > 1 || rawUpper < 0 || rawUpper > 1)
  ) validationFailures.push('probability_out_of_range');
  if (p != null && lo != null && hi != null && !(lo <= p && p <= hi)) {
    validationFailures.push('invalid_probability_interval');
  }
  return Object.freeze({
    pUp: p,
    lower: lo,
    upper: hi,
    modelVersion: modelVersion ?? 'unknown',
    calibrated: Boolean(calibrated),
    valid: Boolean(valid) && validationFailures.length === 0,
    reasons: Object.freeze([...new Set([...reasons, ...validationFailures])]),
  });
}

export function invalidPrediction(modelVersion, reasons) {
  return probabilityPrediction({
    pUp: 0.5,
    lower: 0,
    upper: 1,
    modelVersion,
    calibrated: false,
    valid: false,
    reasons,
  });
}

export class ProbabilityModel {
  // eslint-disable-next-line no-unused-vars
  predict(signalSnapshot) {
    throw new Error('ProbabilityModel.predict not implemented');
  }
}

export function safeLogit(probability, epsilon = 1e-6) {
  const p = Math.max(epsilon, Math.min(1 - epsilon, Number(probability)));
  return Math.log(p / (1 - p));
}

export function logistic(value) {
  const z = Number(value);
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}
