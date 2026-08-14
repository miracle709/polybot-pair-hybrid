import { logistic, safeLogit } from '../src/models/probabilityModel.js';
import { normalCdf } from '../src/models/structuralModel.js';

export const DEFAULT_RESEARCH_FEATURES = Object.freeze([
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

function label(row) {
  return String(row.eventualWinner).toUpperCase() === 'UP' ? 1 : 0;
}

function finiteRows(rows, featureNames) {
  return rows.filter((row) =>
    Number.isFinite(Number(row.marketMidpoint)) &&
    Number(row.marketMidpoint) > 0 &&
    Number(row.marketMidpoint) < 1 &&
    featureNames.every((name) => Number.isFinite(Number(row.features?.[name]))) &&
    ['UP', 'DOWN'].includes(String(row.eventualWinner).toUpperCase())
  );
}

function normalizer(rows, featureNames) {
  const means = {};
  const scales = {};
  for (const name of featureNames) {
    const values = rows.map((row) => Number(row.features[name]));
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    means[name] = mean;
    scales[name] = Math.sqrt(variance) || 1;
  }
  return { means, scales };
}

function vector(row, featureNames, stats) {
  return featureNames.map((name) =>
    (Number(row.features[name]) - stats.means[name]) / stats.scales[name]
  );
}

export function trainResidualLogistic(rows, {
  featureNames = DEFAULT_RESEARCH_FEATURES,
  lambda = 0.1,
  iterations = 500,
  learningRate = 0.1,
} = {}) {
  const training = finiteRows(rows, featureNames);
  if (training.length < 2) throw new Error('at least two finite training rows required');
  const stats = normalizer(training, featureNames);
  const coefficients = new Array(featureNames.length + 1).fill(0);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = new Array(coefficients.length).fill(0);
    for (const row of training) {
      const x = vector(row, featureNames, stats);
      let score = safeLogit(row.marketMidpoint) + coefficients[0];
      for (let i = 0; i < x.length; i += 1) score += coefficients[i + 1] * x[i];
      const error = logistic(score) - label(row);
      gradient[0] += error;
      for (let i = 0; i < x.length; i += 1) gradient[i + 1] += error * x[i];
    }
    for (let i = 0; i < coefficients.length; i += 1) {
      const penalty = i === 0 ? 0 : lambda * coefficients[i];
      coefficients[i] -= learningRate * (gradient[i] / training.length + penalty);
    }
  }
  const named = Object.fromEntries(
    featureNames.map((name, index) => [name, coefficients[index + 1]])
  );
  return Object.freeze({
    featureNames: Object.freeze([...featureNames]),
    intercept: coefficients[0],
    coefficients: Object.freeze(named),
    featureMeans: Object.freeze(stats.means),
    featureScales: Object.freeze(stats.scales),
    sampleCount: training.length,
    lambda,
  });
}

export function predictResidualLogistic(model, row) {
  let score = safeLogit(row.marketMidpoint) + model.intercept;
  for (const name of model.featureNames) {
    score += model.coefficients[name] * (
      (Number(row.features[name]) - model.featureMeans[name]) /
      model.featureScales[name]
    );
  }
  return logistic(score);
}

function wilson(successes, total, z = 1.96) {
  if (total <= 0) return { lower: 0, upper: 1 };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return {
    lower: Math.max(0, (centre - margin) / denominator),
    upper: Math.min(1, (centre + margin) / denominator),
  };
}

export function calibrationBins(predictions, binCount = 10) {
  const bins = [];
  for (let index = 0; index < binCount; index += 1) {
    const minP = index / binCount;
    const maxP = (index + 1) / binCount;
    const members = predictions.filter((item) =>
      item.pUp >= minP && (index === binCount - 1 ? item.pUp <= maxP : item.pUp < maxP)
    );
    const successes = members.reduce((sum, item) => sum + item.y, 0);
    const interval = wilson(successes, members.length);
    bins.push(Object.freeze({
      minP,
      maxP,
      lower: interval.lower,
      upper: interval.upper,
      sampleCount: members.length,
      predictedMean: members.length
        ? members.reduce((sum, item) => sum + item.pUp, 0) / members.length
        : null,
      observedFrequency: members.length ? successes / members.length : null,
    }));
  }
  return Object.freeze(bins);
}

function scoreMetrics(predictions) {
  if (!predictions.length) return { sampleCount: 0, brierScore: null, logLoss: null, calibrationError: null };
  const epsilon = 1e-12;
  const brierScore = predictions.reduce((sum, item) => sum + (item.pUp - item.y) ** 2, 0) / predictions.length;
  const logLoss = -predictions.reduce((sum, item) => {
    const p = Math.max(epsilon, Math.min(1 - epsilon, item.pUp));
    return sum + item.y * Math.log(p) + (1 - item.y) * Math.log(1 - p);
  }, 0) / predictions.length;
  const bins = calibrationBins(predictions);
  const calibrationError = bins.reduce((sum, bin) =>
    sum + (bin.sampleCount / predictions.length) *
      Math.abs((bin.predictedMean ?? 0) - (bin.observedFrequency ?? 0)), 0);
  return { sampleCount: predictions.length, brierScore, logLoss, calibrationError, calibrationBins: bins };
}

function economicMetrics(predictions, bins) {
  let gross = 0;
  let net = 0;
  let capital = 0;
  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  let trades = 0;
  for (const item of predictions) {
    const bin = bins.find((candidate) =>
      item.pUp >= candidate.minP && item.pUp <= candidate.maxP && candidate.sampleCount > 0
    );
    if (!bin) continue;
    const upPrice = Number(
      item.row.executionPriceUp ??
      item.row.features.upBestAsk ??
      item.row.marketMidpoint
    );
    const downPrice = Number(
      item.row.executionPriceDown ??
      item.row.features.downBestAsk ??
      (1 - item.row.marketMidpoint)
    );
    const lower = item.lower ?? bin.lower;
    const upper = item.upper ?? bin.upper;
    const upEdge = lower - upPrice;
    const downEdge = (1 - upper) - downPrice;
    const direction = upEdge > 0 || downEdge > 0
      ? upEdge >= downEdge ? 'UP' : 'DOWN'
      : null;
    if (!direction) continue;
    const price = direction === 'UP' ? upPrice : downPrice;
    const payout = direction === (item.y ? 'UP' : 'DOWN') ? 1 : 0;
    const observed = item.row.executionObservations?.[direction] ?? null;
    const fee = Number(
      observed?.feeUsdPerShare ?? item.row.actualFeeUsdPerShare ?? 0
    );
    const slippage = Number(
      observed?.slippageUsdPerShare ?? item.row.actualSlippageUsdPerShare ?? 0
    );
    const grossPnl = payout - price;
    const netPnl = grossPnl - fee - slippage;
    gross += grossPnl;
    net += netPnl;
    capital += price + fee;
    trades += 1;
    equity += netPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    trades,
    grossDirectionalPnlUsdPerShare: gross,
    netDirectionalPnlUsdPerShare: net,
    netEvPerTrade: trades ? net / trades : 0,
    capitalDeployedUsdPerShare: capital,
    maxDrawdownUsdPerShare: maxDrawdown,
  };
}

function baselinePredictions(rows, kind) {
  return rows.map((row) => {
    let pUp;
    if (kind === 'market') pUp = Number(row.marketMidpoint);
    else if (kind === 'structural') {
      const spot = Number(row.features.settlementReferencePrice);
      const strike = Number(row.features.priceToBeat);
      const sigma = Number(row.features.realizedVolatility);
      const tau = Number(row.features.timeRemainingSeconds);
      if (spot > 0 && strike > 0 && sigma >= 0 && tau >= 0) {
        pUp = tau === 0 || sigma === 0
          ? spot > strike ? 1 : spot < strike ? 0 : 0.5
          : normalCdf(
              (Math.log(spot / strike) - 0.5 * sigma * sigma * tau) /
              (sigma * Math.sqrt(tau))
            );
      } else pUp = Number(row.marketMidpoint);
    }
    else {
      const signs = [
        Math.sign(Number(row.features.btcReturn3sBps)),
        Math.sign(Number(row.features.clobReturn3sBps)),
        Number(row.features.rawGapBps) > 1 ? 1 : Number(row.features.rawGapBps) < -1 ? -1 : 0,
      ];
      pUp = signs.every((sign) => sign === 1)
        ? 0.75
        : signs.every((sign) => sign === -1)
          ? 0.25
          : Number(row.marketMidpoint);
    }
    return { pUp, y: label(row), row };
  });
}

/** Strict past-rounds -> next-rounds walk-forward evaluation. */
export function walkForwardEvaluate(rows, {
  featureNames = DEFAULT_RESEARCH_FEATURES,
  minimumTrainRounds = 50,
  validationRounds = 10,
  lambda = 0.1,
} = {}) {
  const usable = finiteRows(rows, featureNames).sort(
    (a, b) => a.decisionTimestampMs - b.decisionTimestampMs
  );
  const roundOrder = [...new Set(usable.map((row) => row.roundId))];
  const outOfSample = [];
  const folds = [];
  for (
    let split = minimumTrainRounds;
    split < roundOrder.length;
    split += validationRounds
  ) {
    const trainRounds = new Set(roundOrder.slice(0, split));
    const validationIds = roundOrder.slice(split, split + validationRounds);
    const validationSet = new Set(validationIds);
    const training = usable.filter((row) => trainRounds.has(row.roundId));
    const validation = usable.filter((row) => validationSet.has(row.roundId));
    if (!training.length || !validation.length) continue;
    const model = trainResidualLogistic(training, { featureNames, lambda });
    // Probability intervals used for this validation block come only from
    // earlier rounds. Reserve the tail of the training period for causal
    // calibration; never use the validation block's outcomes to trade itself.
    const trainingRoundOrder = roundOrder.slice(0, split);
    const calibrationSplit = Math.max(1, Math.floor(trainingRoundOrder.length * 0.8));
    const calibrationFitRounds = new Set(trainingRoundOrder.slice(0, calibrationSplit));
    const calibrationRounds = new Set(trainingRoundOrder.slice(calibrationSplit));
    const calibrationFit = training.filter((row) => calibrationFitRounds.has(row.roundId));
    const calibrationRows = training.filter((row) => calibrationRounds.has(row.roundId));
    let pastCalibration = [];
    if (calibrationFit.length >= 2 && calibrationRows.length > 0) {
      const calibrationModel = trainResidualLogistic(calibrationFit, { featureNames, lambda });
      pastCalibration = calibrationRows.map((row) => ({
        pUp: predictResidualLogistic(calibrationModel, row),
        y: label(row),
        row,
      }));
    }
    const pastBins = calibrationBins(pastCalibration);
    const foldPredictions = validation.map((row) => ({
      pUp: predictResidualLogistic(model, row),
      y: label(row),
      row,
    })).map((item) => {
      const bin = pastBins.find((candidate) =>
        item.pUp >= candidate.minP && item.pUp <= candidate.maxP && candidate.sampleCount > 0
      );
      return {
        ...item,
        lower: bin?.lower ?? 0,
        upper: bin?.upper ?? 1,
      };
    });
    outOfSample.push(...foldPredictions);
    folds.push(Object.freeze({
      trainThroughRound: roundOrder[split - 1],
      validationRounds: Object.freeze(validationIds),
      trainSampleCount: training.length,
      validationSampleCount: validation.length,
    }));
  }
  const learnedMetrics = scoreMetrics(outOfSample);
  const uncertaintyBins = calibrationBins(outOfSample);
  const finalModel = usable.length >= 2
    ? trainResidualLogistic(usable, { featureNames, lambda })
    : null;
  const market = baselinePredictions(usable, 'market');
  const structural = baselinePredictions(usable, 'structural');
  const legacy = baselinePredictions(usable, 'legacy');
  return Object.freeze({
    chronological: true,
    folds: Object.freeze(folds),
    learned: Object.freeze({
      ...learnedMetrics,
      ...economicMetrics(outOfSample, uncertaintyBins),
    }),
    baselines: Object.freeze({
      marketMidpoint: Object.freeze(scoreMetrics(market)),
      structural: Object.freeze(scoreMetrics(structural)),
      legacyUnanimous: Object.freeze(scoreMetrics(legacy)),
      noAction: Object.freeze({ trades: 0, netDirectionalPnlUsdPerShare: 0, maxDrawdownUsdPerShare: 0 }),
    }),
    artifact: finalModel == null ? null : Object.freeze({
      modelVersion: 'market-residual-logistic-walk-forward-v1',
      ...finalModel,
      validation: Object.freeze({
        calibrated: outOfSample.length > 0,
        method: 'wilson_walk_forward',
        sampleCount: outOfSample.length,
        uncertaintyBins,
        chronological: true,
      }),
    }),
  });
}
