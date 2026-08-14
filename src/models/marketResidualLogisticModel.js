import {
  invalidPrediction,
  logistic,
  probabilityPrediction,
  ProbabilityModel,
  safeLogit,
} from './probabilityModel.js';

const DEFAULT_FEATURES = Object.freeze([
  'rawGapBps',
  'twap30GapBps',
  'btcReturn1sBps',
  'btcReturn3sBps',
  'btcReturn5sBps',
  'btcReturn10sBps',
  'clobReturn1sBps',
  'clobReturn3sBps',
  'clobReturn5sBps',
  'clobReturn10sBps',
  'orderBookImbalance',
  'remainingVolatilityEstimate',
  'timeRemainingSeconds',
]);

function uncertaintyBin(bins, pUp) {
  return (bins ?? []).find((bin) =>
    pUp >= Number(bin.minP ?? 0) && pUp <= Number(bin.maxP ?? 1)
  ) ?? null;
}

/**
 * Runtime-only application of an offline-trained regularized logistic model:
 * logit(pUp) = logit(causal market midpoint) + intercept + beta^T X.
 */
export class MarketResidualLogisticModel extends ProbabilityModel {
  constructor({ artifact, minimumCalibrationSamples = 500 } = {}) {
    super();
    this.artifact = artifact ?? null;
    this.minimumCalibrationSamples = minimumCalibrationSamples;
    this.modelVersion = artifact?.modelVersion ?? 'market-residual-logistic-unconfigured';
  }

  predict(snapshot) {
    if (!this.artifact) return invalidPrediction(this.modelVersion, ['model_artifact_missing']);
    if (!snapshot?.valid) return invalidPrediction(this.modelVersion, ['signal_snapshot_invalid']);
    const pMarket = Number(snapshot.upMid);
    if (!Number.isFinite(pMarket) || pMarket < 0 || pMarket > 1) {
      return invalidPrediction(this.modelVersion, ['market_probability_invalid']);
    }
    const featureNames = this.artifact.featureNames ?? DEFAULT_FEATURES;
    const coefficients = this.artifact.coefficients ?? {};
    const means = this.artifact.featureMeans ?? {};
    const scales = this.artifact.featureScales ?? {};
    let score = safeLogit(pMarket) + Number(this.artifact.intercept ?? 0);
    for (const name of featureNames) {
      const raw = Number(snapshot[name]);
      const coefficient = Number(coefficients[name] ?? 0);
      const mean = Number(means[name] ?? 0);
      const scale = Number(scales[name] ?? 1);
      if (!Number.isFinite(raw) || !Number.isFinite(coefficient) || !Number.isFinite(scale) || scale <= 0) {
        return invalidPrediction(this.modelVersion, [`feature_invalid:${name}`]);
      }
      score += coefficient * ((raw - mean) / scale);
    }
    const pUp = logistic(score);
    const validation = this.artifact.validation ?? {};
    const bin = uncertaintyBin(validation.uncertaintyBins, pUp);
    const method = String(validation.method ?? '');
    const calibrated =
      validation.calibrated === true &&
      Number(validation.sampleCount) >= this.minimumCalibrationSamples &&
      ['isotonic_walk_forward', 'wilson_walk_forward', 'conformal_walk_forward'].includes(method) &&
      bin != null &&
      Number(bin.sampleCount) > 0 &&
      Number.isFinite(Number(bin.lower)) &&
      Number.isFinite(Number(bin.upper));
    // An empirical bin estimates the observed-frequency uncertainty. Expand
    // it conservatively to preserve the public lower <= point <= upper API.
    const lower = calibrated ? Math.min(Number(bin.lower), pUp) : 0;
    const upper = calibrated ? Math.max(Number(bin.upper), pUp) : 1;
    return probabilityPrediction({
      pUp,
      lower,
      upper,
      modelVersion: this.modelVersion,
      calibrated,
      valid: true,
      reasons: calibrated ? [] : ['offline_calibration_not_proven'],
    });
  }
}
