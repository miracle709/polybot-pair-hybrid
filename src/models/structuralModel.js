import {
  invalidPrediction,
  probabilityPrediction,
  ProbabilityModel,
} from './probabilityModel.js';

// Abramowitz-Stegun approximation; deterministic and dependency-free.
export function normalCdf(value) {
  const z = Number(value);
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  if (!Number.isFinite(z)) return 0.5;
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const density = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const tail = density * t * (
    0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))
  );
  const cdf = 1 - tail;
  return z >= 0 ? cdf : 1 - cdf;
}

/**
 * Zero-drift short-horizon diffusion benchmark. Volatility is expected in
 * log-return units per square-root second, matching FeatureEngine.
 * The [0,1] interval is deliberate: this unvalidated baseline makes no
 * unsupported uncertainty claim and therefore cannot authorize capital.
 */
export class StructuralProbabilityModel extends ProbabilityModel {
  constructor({ modelVersion = 'structural-zero-drift-v1' } = {}) {
    super();
    this.modelVersion = modelVersion;
  }

  predict(snapshot) {
    const reasons = [];
    if (!snapshot?.valid) reasons.push('signal_snapshot_invalid');
    const spot = Number(snapshot?.settlementReferencePrice);
    const strike = Number(snapshot?.priceToBeat);
    const tau = Number(snapshot?.timeRemainingSeconds);
    const sigma = Number(snapshot?.realizedVolatility);
    if (!Number.isFinite(spot) || spot <= 0) reasons.push('spot_missing');
    if (!Number.isFinite(strike) || strike <= 0) reasons.push('strike_missing');
    if (!Number.isFinite(tau) || tau < 0) reasons.push('time_remaining_invalid');
    if (!Number.isFinite(sigma) || sigma < 0) reasons.push('volatility_invalid');
    if (reasons.length) return invalidPrediction(this.modelVersion, reasons);

    let pUp;
    if (tau === 0 || sigma === 0) {
      pUp = spot > strike ? 1 : spot < strike ? 0 : 0.5;
    } else {
      const z = (
        Math.log(spot / strike) - 0.5 * sigma * sigma * tau
      ) / (sigma * Math.sqrt(tau));
      pUp = normalCdf(z);
    }
    return probabilityPrediction({
      pUp,
      lower: 0,
      upper: 1,
      modelVersion: this.modelVersion,
      calibrated: false,
      valid: true,
      reasons: ['structural_baseline_uncalibrated'],
    });
  }
}

