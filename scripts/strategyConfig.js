/**
 * Single env → params/guards/sim builder for paper, live, and backtests.
 * Call loadEnv() before buildStrategyConfig().
 */
import { PARAMS, GUARDS } from '../src/config.js';

/** Missing or empty string uses fallback (avoids MAX_RUNG_SHARES= → 0). */
export function numberEnv(name, fallback) {
  const raw = process.env[name];
  const value = Number(raw === undefined || raw === '' ? fallback : raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return value;
}

export function booleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return Boolean(fallback);
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  throw new Error(`${name} must be one of: 0, 1, false, true`);
}

/**
 * @param {Object} opts
 * @param {'paper' | 'live'} opts.feeMode
 *   paper/backtest → PAPER_FEE_BPS (default 0)
 *   live → FEE_BPS (required)
 */
export function buildStrategyConfig({ feeMode }) {
  if (feeMode !== 'paper' && feeMode !== 'live') {
    throw new Error(`feeMode must be 'paper' or 'live', got ${feeMode}`);
  }

  const assumedFeeBps =
    feeMode === 'live'
      ? numberEnv('FEE_BPS')
      : numberEnv('PAPER_FEE_BPS', 0);
  const params = {
    ...PARAMS,
    ENTRY_GATE_SECONDS: numberEnv(
      'ENTRY_GATE_SECONDS',
      PARAMS.ENTRY_GATE_SECONDS
    ),
    OPENING_CONSERVATIVE_UNTIL_SECONDS: numberEnv(
      'OPENING_CONSERVATIVE_UNTIL_SECONDS',
      PARAMS.OPENING_CONSERVATIVE_UNTIL_SECONDS
    ),
    OPENING_MAX_RUNG_SHARES: numberEnv(
      'OPENING_MAX_RUNG_SHARES',
      PARAMS.OPENING_MAX_RUNG_SHARES
    ),
    PAIR_TARGET_MILS: numberEnv('PAIR_TARGET_MILS', PARAMS.PAIR_TARGET_MILS),
    PAIR_EXECUTION_BUFFER_MILS: numberEnv(
      'PAIR_EXECUTION_BUFFER_MILS',
      PARAMS.PAIR_EXECUTION_BUFFER_MILS
    ),
    PAIR_HARD_MAX_MILS: numberEnv(
      'PAIR_HARD_MAX_MILS',
      PARAMS.PAIR_HARD_MAX_MILS
    ),
    MAX_UNMATCHED_SHARES: numberEnv(
      'MAX_UNMATCHED_SHARES',
      PARAMS.MAX_UNMATCHED_SHARES
    ),
    MAX_UNMATCHED_AGE_SECONDS: numberEnv(
      'MAX_UNMATCHED_AGE_SECONDS',
      PARAMS.MAX_UNMATCHED_AGE_SECONDS
    ),
    ALLOW_NEGATIVE_PAIR_LOCK: booleanEnv(
      'ALLOW_NEGATIVE_PAIR_LOCK',
      PARAMS.ALLOW_NEGATIVE_PAIR_LOCK
    ),
    PAIR_DISCOVERY_START_SECONDS: numberEnv(
      'PAIR_DISCOVERY_START_SECONDS',
      process.env.ENTRY_GATE_SECONDS === undefined
        ? PARAMS.PAIR_DISCOVERY_START_SECONDS
        : numberEnv('ENTRY_GATE_SECONDS', PARAMS.ENTRY_GATE_SECONDS)
    ),
    PAIR_ACCUMULATION_START_SECONDS: numberEnv(
      'PAIR_ACCUMULATION_START_SECONDS',
      PARAMS.PAIR_ACCUMULATION_START_SECONDS
    ),
    PAIR_ACCUMULATION_END_SECONDS: numberEnv(
      'PAIR_ACCUMULATION_END_SECONDS',
      PARAMS.PAIR_ACCUMULATION_END_SECONDS
    ),
    PAIR_COMPLETION_END_SECONDS: numberEnv(
      'PAIR_COMPLETION_END_SECONDS',
      PARAMS.PAIR_COMPLETION_END_SECONDS
    ),
    PAIR_RISK_REDUCTION_END_SECONDS: numberEnv(
      'PAIR_RISK_REDUCTION_END_SECONDS',
      PARAMS.PAIR_RISK_REDUCTION_END_SECONDS
    ),
    REPLENISH_AHEAD_LEG: booleanEnv(
      'REPLENISH_AHEAD_LEG',
      PARAMS.REPLENISH_AHEAD_LEG
    ),
    V3_ENABLED: booleanEnv('V3_ENABLED', PARAMS.V3_ENABLED),
    V3_SHADOW_ONLY: booleanEnv('V3_SHADOW_ONLY', PARAMS.V3_SHADOW_ONLY),
    DIRECTIONAL_ENABLED: booleanEnv(
      'DIRECTIONAL_ENABLED',
      PARAMS.DIRECTIONAL_ENABLED
    ),
    DIRECTIONAL_MAKER_ENABLED: booleanEnv(
      'DIRECTIONAL_MAKER_ENABLED',
      PARAMS.DIRECTIONAL_MAKER_ENABLED
    ),
    DIRECTIONAL_TAKER_ENABLED: booleanEnv(
      'DIRECTIONAL_TAKER_ENABLED',
      PARAMS.DIRECTIONAL_TAKER_ENABLED
    ),
    ALLOW_MODEL_TO_DEFER_PAIR_COMPLETION: booleanEnv(
      'ALLOW_MODEL_TO_DEFER_PAIR_COMPLETION',
      PARAMS.ALLOW_MODEL_TO_DEFER_PAIR_COMPLETION
    ),
    SIGNAL_BOOK_MAX_AGE_MS: numberEnv(
      'SIGNAL_BOOK_MAX_AGE_MS',
      PARAMS.SIGNAL_BOOK_MAX_AGE_MS
    ),
    SIGNAL_BTC_MAX_AGE_MS: numberEnv(
      'SIGNAL_BTC_MAX_AGE_MS',
      PARAMS.SIGNAL_BTC_MAX_AGE_MS
    ),
    SIGNAL_REFERENCE_MAX_AGE_MS: numberEnv(
      'SIGNAL_REFERENCE_MAX_AGE_MS',
      PARAMS.SIGNAL_REFERENCE_MAX_AGE_MS
    ),
    V3_DECISION_INTERVAL_MS: numberEnv(
      'V3_DECISION_INTERVAL_MS',
      PARAMS.V3_DECISION_INTERVAL_MS
    ),
    SIGNAL_VOLATILITY_WINDOW_MS: numberEnv(
      'SIGNAL_VOLATILITY_WINDOW_MS',
      PARAMS.SIGNAL_VOLATILITY_WINDOW_MS
    ),
    SIGNAL_TWAP_WINDOW_MS: numberEnv(
      'SIGNAL_TWAP_WINDOW_MS',
      PARAMS.SIGNAL_TWAP_WINDOW_MS
    ),
    V3_MAKER_FEE_BPS: numberEnv('V3_MAKER_FEE_BPS', assumedFeeBps),
    V3_BUILDER_FEE_BPS: numberEnv(
      'V3_BUILDER_FEE_BPS',
      PARAMS.V3_BUILDER_FEE_BPS
    ),
    DIRECTIONAL_MAKER_RESERVE_BPS: numberEnv(
      'DIRECTIONAL_MAKER_RESERVE_BPS',
      PARAMS.DIRECTIONAL_MAKER_RESERVE_BPS
    ),
    DIRECTIONAL_TAKER_RESERVE_BPS: numberEnv(
      'DIRECTIONAL_TAKER_RESERVE_BPS',
      PARAMS.DIRECTIONAL_TAKER_RESERVE_BPS
    ),
    MAX_DIRECTIONAL_LOSS_USD: numberEnv(
      'MAX_DIRECTIONAL_LOSS_USD',
      PARAMS.MAX_DIRECTIONAL_LOSS_USD
    ),
    MAX_DIRECTIONAL_SHARES: numberEnv(
      'MAX_DIRECTIONAL_SHARES',
      PARAMS.MAX_DIRECTIONAL_SHARES
    ),
    DIRECTIONAL_SIZE_STEP_SHARES: numberEnv(
      'DIRECTIONAL_SIZE_STEP_SHARES',
      PARAMS.DIRECTIONAL_SIZE_STEP_SHARES
    ),
    MIN_DIRECTIONAL_ROBUST_EV_USD: numberEnv(
      'MIN_DIRECTIONAL_ROBUST_EV_USD',
      PARAMS.MIN_DIRECTIONAL_ROBUST_EV_USD
    ),
    MIN_DIRECTIONAL_TAKER_ROBUST_EV_USD: numberEnv(
      'MIN_DIRECTIONAL_TAKER_ROBUST_EV_USD',
      PARAMS.MIN_DIRECTIONAL_TAKER_ROBUST_EV_USD
    ),
    MIN_DIRECTIONAL_STRONG_ROBUST_EV_USD: numberEnv(
      'MIN_DIRECTIONAL_STRONG_ROBUST_EV_USD',
      PARAMS.MIN_DIRECTIONAL_STRONG_ROBUST_EV_USD
    ),
    MAX_TAKER_DEPTH_FRACTION: numberEnv(
      'MAX_TAKER_DEPTH_FRACTION',
      PARAMS.MAX_TAKER_DEPTH_FRACTION
    ),
    DIRECTIONAL_REDUCE_START_SECONDS: numberEnv(
      'DIRECTIONAL_REDUCE_START_SECONDS',
      PARAMS.DIRECTIONAL_REDUCE_START_SECONDS
    ),
    DIRECTIONAL_STRONG_ONLY_START_SECONDS: numberEnv(
      'DIRECTIONAL_STRONG_ONLY_START_SECONDS',
      PARAMS.DIRECTIONAL_STRONG_ONLY_START_SECONDS
    ),
    DIRECTIONAL_STOP_NEW_SECONDS: numberEnv(
      'DIRECTIONAL_STOP_NEW_SECONDS',
      PARAMS.DIRECTIONAL_STOP_NEW_SECONDS
    ),
    DIRECTIONAL_LATE_SIZE_FRACTION: numberEnv(
      'DIRECTIONAL_LATE_SIZE_FRACTION',
      PARAMS.DIRECTIONAL_LATE_SIZE_FRACTION
    ),
    SIGNAL_MAKER_SKEW_ENABLED: booleanEnv(
      'SIGNAL_MAKER_SKEW_ENABLED',
      PARAMS.SIGNAL_MAKER_SKEW_ENABLED
    ),
    MAX_SIGNAL_SKEW_MILS: numberEnv(
      'MAX_SIGNAL_SKEW_MILS',
      PARAMS.MAX_SIGNAL_SKEW_MILS
    ),
    MAX_SIGNAL_SIZE_TILT_FRACTION: numberEnv(
      'MAX_SIGNAL_SIZE_TILT_FRACTION',
      PARAMS.MAX_SIGNAL_SIZE_TILT_FRACTION
    ),
    DYNAMIC_SIZING_ENABLED: process.env.DYNAMIC_SIZING !== '0',
    RUNG_DEPTH_FRACTION: numberEnv(
      'RUNG_DEPTH_FRACTION',
      PARAMS.RUNG_DEPTH_FRACTION
    ),
    MIN_ORDER_NOTIONAL_USD: numberEnv(
      'MIN_ORDER_NOTIONAL_USD',
      PARAMS.MIN_ORDER_NOTIONAL_USD
    ),
    MIN_RUNG_SHARES: numberEnv('MIN_RUNG_SHARES', PARAMS.MIN_RUNG_SHARES),
    MAX_RUNG_SHARES: numberEnv('MAX_RUNG_SHARES', PARAMS.MAX_RUNG_SHARES),
    MAX_LEG_SHARES: numberEnv('MAX_LEG_SHARES', PARAMS.MAX_LEG_SHARES),
    ASSUMED_FEE_BPS_OF_NOTIONAL: assumedFeeBps,
    POLYMARKET_TAKER_FEE_RATE: numberEnv('POLYMARKET_TAKER_FEE_RATE', 0.07),
    MIN_REQUOTE_INTERVAL_MS: numberEnv(
      'MIN_REQUOTE_INTERVAL_MS',
      PARAMS.MIN_REQUOTE_INTERVAL_MS
    ),
  };
  if (
    params.OPENING_CONSERVATIVE_UNTIL_SECONDS < params.ENTRY_GATE_SECONDS ||
    params.OPENING_MAX_RUNG_SHARES < params.MIN_RUNG_SHARES ||
    params.MIN_ORDER_NOTIONAL_USD < 1 ||
    params.MIN_RUNG_SHARES <= 0 ||
    params.MAX_RUNG_SHARES < params.MIN_RUNG_SHARES ||
    params.MAX_LEG_SHARES < params.MIN_RUNG_SHARES ||
    params.RUNG_DEPTH_FRACTION <= 0 ||
    params.RUNG_DEPTH_FRACTION > 1 ||
    params.PAIR_TARGET_MILS <= 0 ||
    params.PAIR_TARGET_MILS > params.PAIR_HARD_MAX_MILS ||
    params.PAIR_HARD_MAX_MILS > 1000 ||
    params.MAX_UNMATCHED_SHARES <= 0 ||
    params.MAX_UNMATCHED_AGE_SECONDS <= 0 ||
    params.PAIR_DISCOVERY_START_SECONDS >
      params.PAIR_ACCUMULATION_START_SECONDS ||
    params.PAIR_ACCUMULATION_START_SECONDS >
      params.PAIR_ACCUMULATION_END_SECONDS ||
    params.PAIR_ACCUMULATION_END_SECONDS >
      params.PAIR_COMPLETION_END_SECONDS ||
    params.PAIR_COMPLETION_END_SECONDS >
      params.PAIR_RISK_REDUCTION_END_SECONDS ||
    params.PAIR_RISK_REDUCTION_END_SECONDS > params.QUOTE_STOP_SECONDS ||
    params.QUOTE_STOP_SECONDS > params.ROUND_SECONDS ||
    params.SIGNAL_BOOK_MAX_AGE_MS <= 0 ||
    params.SIGNAL_BTC_MAX_AGE_MS <= 0 ||
    params.SIGNAL_REFERENCE_MAX_AGE_MS <= 0 ||
    params.V3_DECISION_INTERVAL_MS <= 0 ||
    params.SIGNAL_VOLATILITY_WINDOW_MS <= 0 ||
    params.SIGNAL_TWAP_WINDOW_MS <= 0 ||
    params.MAX_DIRECTIONAL_LOSS_USD <= 0 ||
    params.MAX_DIRECTIONAL_SHARES < params.MIN_RUNG_SHARES ||
    params.DIRECTIONAL_SIZE_STEP_SHARES <= 0 ||
    params.MAX_TAKER_DEPTH_FRACTION <= 0 ||
    params.MAX_TAKER_DEPTH_FRACTION > 1 ||
    params.DIRECTIONAL_REDUCE_START_SECONDS >
      params.DIRECTIONAL_STRONG_ONLY_START_SECONDS ||
    params.DIRECTIONAL_STRONG_ONLY_START_SECONDS >
      params.DIRECTIONAL_STOP_NEW_SECONDS ||
    params.DIRECTIONAL_STOP_NEW_SECONDS > params.ROUND_SECONDS ||
    params.DIRECTIONAL_LATE_SIZE_FRACTION <= 0 ||
    params.DIRECTIONAL_LATE_SIZE_FRACTION > 1 ||
    params.MAX_SIGNAL_SIZE_TILT_FRACTION > 1
  ) {
    throw new Error('invalid opening/dynamic sizing or pair-cycle configuration');
  }
  if (params.V3_ENABLED && !params.V3_SHADOW_ONLY) {
    throw new Error(
      'V3 active execution is not authorized in the shadow-ready milestone; ' +
        'set V3_SHADOW_ONLY=1'
    );
  }

  const guards = structuredClone(GUARDS);
  guards.MAX_ROUND_NOTIONAL_USD.softLimit = numberEnv(
    'ROUND_SOFT_CAP',
    GUARDS.MAX_ROUND_NOTIONAL_USD.softLimit
  );
  guards.MAX_ROUND_NOTIONAL_USD.hardLimit = numberEnv(
    'ROUND_HARD_CAP',
    GUARDS.MAX_ROUND_NOTIONAL_USD.hardLimit
  );
  guards.MAX_TILT_SHARES = numberEnv(
    'MAX_TILT_SHARES',
    GUARDS.MAX_TILT_SHARES
  );
  if (
    guards.MAX_ROUND_NOTIONAL_USD.softLimit <= 0 ||
    guards.MAX_ROUND_NOTIONAL_USD.hardLimit <= 0 ||
    guards.MAX_ROUND_NOTIONAL_USD.hardLimit <
      guards.MAX_ROUND_NOTIONAL_USD.softLimit ||
    guards.MAX_TILT_SHARES <= 0
  ) {
    throw new Error('invalid round risk configuration');
  }

  const tradeFraction = numberEnv('PAPER_TRADE_FRACTION', 0.6);
  if (!(tradeFraction > 0 && tradeFraction <= 1)) {
    throw new Error('PAPER_TRADE_FRACTION must be in (0, 1]');
  }

  const sim = {
    feeBps: params.ASSUMED_FEE_BPS_OF_NOTIONAL,
    queueAheadFactor: numberEnv('PAPER_QUEUE_AHEAD', 1),
    placeLatencyMs: numberEnv('PAPER_PLACE_LATENCY_MS', 600),
    cancelLatencyMs: numberEnv('PAPER_CANCEL_LATENCY_MS', 600),
    tradeFraction,
    takerFeeRate: params.POLYMARKET_TAKER_FEE_RATE,
  };

  return { params, guards, sim };
}
