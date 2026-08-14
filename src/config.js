/**
 * Reconstructed parameters for Polymarket wallet 0x3048d65321be3497164cdfc2996f94f98a2e7537
 * ("Flashy-Gold" / twitter-CryptoWithGab), BTC up/down 5-minute markets.
 *
 * Derived from: 1,473 rounds / 124.2h of fills (40,718 buys, 0 sells),
 * 161,808 one-second L2 book snapshots, 641 scored rounds.
 *
 * Confidence tags on every value:
 *   [M] measured directly from his fills / the book
 *   [I] inferred with supporting statistics, not directly observable
 *   [U] unknown — value is a placeholder you must set yourself
 *
 * PRICES ARE INTEGER MILS EVERYWHERE INSIDE THIS BOT (1..999).
 * Floating-point probabilities only exist at the exchange boundary.
 * This is deliberate: 0.1 + 0.2 !== 0.3, and a one-tick offset that
 * silently becomes 0.9999999 ticks will produce orders at the wrong level.
 * Mils rather than cents because the venue's tail tick is 0.001.
 *
 * Tick size is NOT uniform: 0.01 in the body of the book, 0.001 in the
 * tails. See util.tickSizeMils(). Inside the wallet's 0.12-0.89 band it
 * is always 10 mils.
 */

export const PARAMS = {
  // ---------------------------------------------------------------- timing
  /**
   * [I] Deployment entry gate. Source wallet: zero fills before t=13.
   * Not a data artifact: the book is 1c wide from t=0, the strike is
   * captured by t=1-2s, and the mid leaves 0.50 at median t=1s.
   * corr(first mid move, first fill) = 0.002.
   */
  ENTRY_GATE_SECONDS: 20,

  /**
   * Target-aligned opening: the source wallet is non-directional and first
   * fills at t>=13s. After the entry gate, quote both legs passively with
   * the normal ladder; opening max shares softens size until this second.
   * Dynamic sizing remains the deliberate exception.
   */
  OPENING_CONSERVATIVE_UNTIL_SECONDS: 30,
  OPENING_MAX_RUNG_SHARES: 20,

  /**
   * [M] The target keeps quoting through the round and exits by redemption.
   */
  QUOTE_STOP_SECONDS: 300,

  /** [M] Round length for btc-updown-5m-*. */
  ROUND_SECONDS: 300,

  // ------------------------------------------------------ V2 pair economics
  /** Gross pair target before the execution and fee buffers. */
  PAIR_TARGET_MILS: 985,
  /** Additional allowance reserved for execution uncertainty. */
  PAIR_EXECUTION_BUFFER_MILS: 5,
  /** Absolute completed-pair ceiling unless explicitly overridden. */
  PAIR_HARD_MAX_MILS: 995,

  /** Maximum one-sided exposure permitted between pair completions. */
  MAX_UNMATCHED_SHARES: 10,
  /** Maximum age of the oldest incomplete pair cycle. */
  MAX_UNMATCHED_AGE_SECONDS: 60,
  /** Emergency override; false keeps negative pair locks prohibited. */
  ALLOW_NEGATIVE_PAIR_LOCK: false,

  PAIR_DISCOVERY_START_SECONDS: 20,
  // Explicit because the requested DISCOVERY -> ACCUMULATION boundary is 90s.
  PAIR_ACCUMULATION_START_SECONDS: 90,
  PAIR_ACCUMULATION_END_SECONDS: 210,
  PAIR_COMPLETION_END_SECONDS: 260,
  PAIR_RISK_REDUCTION_END_SECONDS: 285,

  /** Do not top up the side that already owns unmatched inventory. */
  REPLENISH_AHEAD_LEG: false,

  // ------------------------------------------------------- V3 shadow engine
  /** V2 remains the live execution path unless this is explicitly enabled. */
  V3_ENABLED: false,
  /** Shadow decisions are recorded but can never submit directional orders. */
  V3_SHADOW_ONLY: true,
  DIRECTIONAL_ENABLED: false,
  DIRECTIONAL_MAKER_ENABLED: false,
  DIRECTIONAL_TAKER_ENABLED: false,
  ALLOW_MODEL_TO_DEFER_PAIR_COMPLETION: false,

  /** Directional data freshness is intentionally far below signal horizons. */
  SIGNAL_BOOK_MAX_AGE_MS: 1000,
  SIGNAL_BTC_MAX_AGE_MS: 1000,
  SIGNAL_REFERENCE_MAX_AGE_MS: 1500,
  V3_DECISION_INTERVAL_MS: 250,
  SIGNAL_VOLATILITY_WINDOW_MS: 30000,
  SIGNAL_TWAP_WINDOW_MS: 30000,

  /** Action-specific expected execution costs. */
  V3_MAKER_FEE_BPS: 0,
  V3_BUILDER_FEE_BPS: 0,
  POLYMARKET_TAKER_FEE_RATE: 0.07,
  DIRECTIONAL_MAKER_RESERVE_BPS: 10,
  DIRECTIONAL_TAKER_RESERVE_BPS: 25,

  /** Explicit probabilistic risk budget; pair economics remain separate. */
  MAX_DIRECTIONAL_LOSS_USD: 5,
  MAX_DIRECTIONAL_SHARES: 10,
  DIRECTIONAL_SIZE_STEP_SHARES: 1,
  MIN_DIRECTIONAL_ROBUST_EV_USD: 0.05,
  MIN_DIRECTIONAL_TAKER_ROBUST_EV_USD: 0.15,
  MIN_DIRECTIONAL_STRONG_ROBUST_EV_USD: 0.25,
  MAX_TAKER_DEPTH_FRACTION: 0.25,
  DIRECTIONAL_REDUCE_START_SECONDS: 210,
  DIRECTIONAL_STRONG_ONLY_START_SECONDS: 260,
  DIRECTIONAL_STOP_NEW_SECONDS: 270,
  DIRECTIONAL_LATE_SIZE_FRACTION: 0.5,

  /** Signal-aware quote skew is scaffolded and disabled for this milestone. */
  SIGNAL_MAKER_SKEW_ENABLED: false,
  MAX_SIGNAL_SKEW_MILS: 10,
  MAX_SIGNAL_SIZE_TILT_FRACTION: 0.25,

  // ------------------------------------------------------------- band gate
  /**
   * [M] He quotes only while the leg's own implied probability sits inside
   * this band. Activity per 100 seconds of market time:
   *   inside 0.12-0.89 ......... 5.6 - 9.3 fills
   *   0.89 - 0.95 .............. 1.75 fills   (-77%)
   *   above 0.95 ............... 0.14 fills   (-98%)
   * Band leakage in the full sample: 0.101% of fills below 0.12,
   * 0.079% above 0.89. Treated here as a hard gate.
   */
  BAND_LOW_MILS: 120,
  BAND_HIGH_MILS: 890,

  /**
   * [M] Absolute clamp on the price he will pay. Distinct from the band
   * gate: the band is evaluated on the leg's MID, this clamps the actual
   * limit price of each rung. min observed 0.06, max 0.90, with sharp
   * cliffs at 0.12 and 0.89.
   */
  MIN_LIMIT_MILS: 120,
  MAX_LIMIT_MILS: 890,

  // ------------------------------------------------------------- placement
  /**
   * [M] Resting offset behind his own leg's best bid, in ticks.
   * Median = 1 in EVERY state tested. He does not join the touch and does
   * not widen late.
   */
  BASE_OFFSET_TICKS: 1,

  /**
   * [I] Concurrent live rungs per leg. Not directly observable — inferred
   * from burst structure: 76% of his fill bursts touch exactly one price
   * level, and multi-level bursts span a median of 2 cents.
   */
  LADDER_LEVELS: 2,

  // ---------------------------------------------------------------- sizing
  /**
   * [M] Fallback fixed leg allocation when DYNAMIC_SIZING_ENABLED is false.
   * Nothing in the entire dataset exceeds 90.00 on a single fill leg.
   */
  RUNG_SHARES: 20,

  /**
   * Depth-sized leg model: target 10% of resting bid depth within two
   * ticks, then split that total across the active ladder levels. This keeps
   * the aggregate quote per leg at the intended participation fraction.
   */
  DYNAMIC_SIZING_ENABLED: true,
  RUNG_DEPTH_FRACTION: 0.10,
  DEPTH_SIZING_TICKS: 2,
  /** Polymarket requires every individual order to be worth at least $1. */
  MIN_ORDER_NOTIONAL_USD: 1,
  MIN_RUNG_SHARES: 5,
  MAX_RUNG_SHARES: 20,
  MAX_LEG_SHARES: 20,
  RUNG_SIZE_STEP_SHARES: 1,

  /**
   * [I] Top a partially-consumed rung back up to target size.
   * Supported by the fill tape: the same (round, leg, price) level is
   * refilled at least twice in 30.4% of cases.
   */
  REPLENISH_PARTIAL_RUNGS: true,

  /**
   * [I] He reprices on book change, not on a timer. Floor between
   * reconciliations to avoid pointless churn.
   */
  MIN_REQUOTE_INTERVAL_MS: 500,

  // ----------------------------------------------------------- log volume
  /**
   * Intents are recorded only on change, with a heartbeat so a quiet book
   * still leaves a trail.
   */
  INTENT_HEARTBEAT_MS: 5000,
  /** Periodic book snapshot: the rung set only moves when the BID moves. */
  BOOK_SNAPSHOT_MS: 1000,

  // ------------------------------------------------------------------ fees
  /**
   * [U] CRITICAL. His fills carry fee 0.0, but your account may not.
   * His gross edge is ~1.9% of deployed USDC. VERIFY THIS ON YOUR OWN
   * ACCOUNT before deploying. The preflight check in engine.js refuses
   * to start until you set this explicitly (via FEE_BPS / PAPER_FEE_BPS).
   */
  ASSUMED_FEE_BPS_OF_NOTIONAL: null,
};

/**
 * Local risk bounds used by the quoter. The hard limit includes current
 * filled cost and every desired resting buy, so a fully-filled desired ladder
 * cannot take the round beyond the configured USD budget.
 */
export const GUARDS = {
  MAX_ROUND_NOTIONAL_USD: { softLimit: 200, hardLimit: 250 },
  MAX_TILT_SHARES: 20,
};

/** Market wiring. */
export const MARKET = {
  seriesSlugPrefix: 'btc-updown-5m-',
  legs: ['UP', 'DOWN'],
};

export default { PARAMS, GUARDS, MARKET };
