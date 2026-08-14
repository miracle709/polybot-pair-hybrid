/**
 * Event schema for the activity log.
 *
 * Every builder is a plain object literal — no classes, no getters, no
 * computed properties beyond what the caller already has in hand. These run
 * on the hot path, so the cost must stay at "allocate one object".
 *
 * Field naming is deliberately short and stable; this file is the contract
 * for anything that later parses the JSONL.
 *
 * Common fields on every event:
 *   t     epoch millis (Date.now(), not an ISO string — formatting is a
 *         parse-time concern, and toISOString() is ~40x the cost)
 *   type  event discriminator
 *   rid   round id (the round slug)
 */

export const EventType = {
  ROUND_OPEN: 'ROUND_START',
  PRICE_TO_BEAT: 'PRICE_TO_BEAT_CAPTURED',
  QUOTE_INTENT: 'QUOTE_INTENT',
  ORDER_PLACED: 'ORDER_PLACED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_REJECTED: 'ORDER_REJECTED',
  FILL: 'WALLET_FILL',
  BOOK_SNAPSHOT: 'TICK',
  ROUND_SETTLED: 'ROUND_RESULT',
  REDEEM: 'REDEEM',
  HALT: 'HALT',
  HEALTH: 'HEALTH',
  MARKOUT: 'MAKER_MARKOUT',
  SIGNAL_SNAPSHOT: 'signal_snapshot',
  PROBABILITY_PREDICTION: 'probability_prediction',
  ACTION_CANDIDATES: 'action_candidates',
  ACTION_SELECTED: 'action_selected',
  ACTION_REJECTED: 'action_rejected',
  V3_SHADOW_DECISION: 'v3_shadow_decision',
  PAIR_COMPLETION_OBSERVATION: 'pair_completion_observation',
};

/** Order lifecycle states, as written to `st`. */
export const OrderStatus = {
  INTENT: 'intent',       // quoter wants this rung; nothing sent yet
  RESTING: 'resting',     // acknowledged by the venue, live in the book
  PARTIAL: 'partial',     // partially consumed, remainder still resting
  FILLED: 'filled',       // fully consumed
  CANCELLED: 'cancelled', // pulled by the requote loop or the kill switch
  REJECTED: 'rejected',   // venue refused it
  SETTLED: 'settled',     // round resolved, position marked
  REDEEMED: 'redeemed',   // on-chain claim confirmed
};

const roundEndEpoch = (roundSlug) => {
  const start = Number(
    String(roundSlug).slice(String(roundSlug).lastIndexOf('-') + 1)
  );
  return Number.isInteger(start) && start > 1_000_000_000
    ? start + 300
    : Date.now() / 1000;
};

export const roundOpen = (rid, windowStart, tokenIds) => ({
  t: Date.now(),
  ts: Date.now() / 1000,
  type: EventType.ROUND_OPEN,
  rid,
  round_slug: rid,
  ws: windowStart,
  window_start_epoch: windowStart,
  window_end_epoch: windowStart + 300,
  up_token: tokenIds?.UP ?? null,
  dn_token: tokenIds?.DOWN ?? null,
  token_id_up: tokenIds?.UP ?? null,
  token_id_down: tokenIds?.DOWN ?? null,
  condition_id: null,
  price_to_beat: null,
  raw_market: null,
});

/**
 * The Chainlink open that the round settles against, plus the reference
 * spot at capture time. `src` records where it came from — do not silently
 * mix chainlink_open with a Binance print, they differ by ~$60 and the
 * whole round hinges on the difference.
 */
export const priceToBeat = (rid, {
  ptb,
  src,
  poly,
  binance,
  sec,
  sourceQuality,
  publisherTimeMs,
  arrivalTimeMs,
}) => ({
  t: Date.now(),
  ts: Date.now() / 1000,
  type: EventType.PRICE_TO_BEAT,
  rid,
  round_slug: rid,
  ptb,
  price_to_beat: ptb,
  ptb_src: src ?? null,
  source: src ?? null,
  source_quality: sourceQuality ?? null,
  publisher_time_ms: publisherTimeMs ?? null,
  arrival_time_ms: arrivalTimeMs ?? null,
  poly_btc: poly ?? null,
  bnc_btc: binance ?? null,
  sec: sec ?? null,
  seconds_into_round: sec ?? null,
  window_start_epoch: Number(rid?.split('-').at(-1)) || null,
});

/**
 * What the quoter decided, before anything is sent. Logging intents as well
 * as placements is what lets you reconstruct WHY a rung was or wasn't
 * there — including the suppression reasons (band gate, tilt limit, etc).
 */
export const quoteIntent = (rid, sec, rungs, suppressed, mkt, decision = null) => ({
  t: Date.now(),
  type: EventType.QUOTE_INTENT,
  rid,
  sec,
  st: OrderStatus.INTENT,
  n: rungs.length,
  rungs: rungs.map((r) => ({ leg: r.leg, p: r.mils, sh: r.shares, off: r.offsetTicks })),
  sup: suppressed.length ? suppressed.map((s) => `${s.leg}:${s.reason}`) : undefined,
  up_bid: mkt?.up_bid ?? null,
  up_ask: mkt?.up_ask ?? null,
  dn_bid: mkt?.dn_bid ?? null,
  dn_ask: mkt?.dn_ask ?? null,
  pair_regime: decision?.regime ?? null,
  pair_cycle_state: decision?.pairCycleState ?? null,
  complement_cap_mils: decision?.complementCapMils ?? null,
  pause_new_cycles: decision?.pauseNewCycles ?? false,
});

export const orderPlaced = (rid, sec, {
  leg,
  mils,
  shares,
  offsetTicks,
  orderId,
  replenish,
  strategyIntent,
  actionCandidateId,
  signalSnapshotId,
  modelVersion,
  expectedEdgeAtDecision,
}) => ({
  t: Date.now(),
  type: EventType.ORDER_PLACED,
  rid,
  sec,
  st: OrderStatus.RESTING,
  oid: orderId,
  leg,
  p: mils,
  sh: shares,
  off: offsetTicks,
  rep: replenish || undefined,
  ...(strategyIntent != null ? { strategy_intent: strategyIntent } : {}),
  ...(actionCandidateId != null ? { action_candidate_id: actionCandidateId } : {}),
  ...(signalSnapshotId != null ? { signal_snapshot_id: signalSnapshotId } : {}),
  ...(modelVersion != null ? { model_version: modelVersion } : {}),
  ...(expectedEdgeAtDecision != null
    ? { expected_edge_at_decision: expectedEdgeAtDecision }
    : {}),
});

export const orderCancelled = (rid, sec, { leg, mils, orderIds, restingShares, ageMs }) => ({
  t: Date.now(),
  type: EventType.ORDER_CANCELLED,
  rid,
  sec,
  st: OrderStatus.CANCELLED,
  oid: orderIds,
  leg,
  p: mils,
  sh_left: restingShares,
  age_ms: ageMs,
});

export const orderRejected = (rid, sec, { leg, mils, shares, reason }) => ({
  t: Date.now(),
  type: EventType.ORDER_REJECTED,
  rid,
  sec,
  st: OrderStatus.REJECTED,
  leg,
  p: mils,
  sh: shares,
  err: reason,
});

/**
 * A fill. This is the row that matters most downstream, so it carries the
 * full context needed to reproduce the reconstruction's own metrics:
 * maker/taker, the touch at fill time, the resulting inventory and the
 * running pair cost.
 *
 * `role` comes from the venue's private fill stream. Do NOT infer it from
 * public data-API timestamps — those are block times and lag the match.
 */
export const fill = (
  rid,
  sec,
  {
    leg,
    mils,
    shares,
    role,
    fee,
    feeRateBps,
    orderId,
    full,
    status,
    transactionHash,
    raw,
    strategyIntent,
    actionCandidateId,
    signalSnapshotId,
    modelVersion,
    expectedEdgeAtDecision,
  },
  book,
  inv
) => ({
  t: Date.now(),
  ts: Date.now() / 1000,
  type: EventType.FILL,
  rid,
  round_slug: rid,
  sec,
  seconds_into_round: sec,
  st: full ? OrderStatus.FILLED : OrderStatus.PARTIAL,
  fill_status: status ?? (full ? 'FULL' : 'PARTIAL'),
  transaction_hash: transactionHash ?? null,
  fee_rate_bps: feeRateBps ?? null,
  oid: orderId ?? null,
  leg,
  outcome: leg === 'UP' ? 'Up' : 'Down',
  side: 'BUY',
  p: mils,
  price: mils / 1000,
  sh: shares,
  shares,
  usd: Math.round(((shares * mils) / 1000) * 10000) / 10000,
  usdc_size: Math.round(((shares * mils) / 1000) * 10000) / 10000,
  role: role ?? null,
  fee: fee ?? 0,
  raw: raw ?? null,
  strategy_intent: strategyIntent ?? null,
  action_candidate_id: actionCandidateId ?? null,
  signal_snapshot_id: signalSnapshotId ?? null,
  model_version: modelVersion ?? null,
  expected_edge_at_decision: expectedEdgeAtDecision ?? null,
  up_bid: book?.up_bid ?? null,
  up_ask: book?.up_ask ?? null,
  dn_bid: book?.dn_bid ?? null,
  dn_ask: book?.dn_ask ?? null,
  best_bid_at_fill:
    leg === 'UP'
      ? (book?.up_bid == null ? null : book.up_bid / 1000)
      : (book?.dn_bid == null ? null : book.dn_bid / 1000),
  best_ask_at_fill:
    leg === 'UP'
      ? (book?.up_ask == null ? null : book.up_ask / 1000)
      : (book?.dn_ask == null ? null : book.dn_ask / 1000),
  net_shares_up: inv?.up ?? null,
  net_shares_down: inv?.dn ?? null,
  // offset of the fill price from that leg's touch, in ticks. Negative
  // means it printed above the bid, i.e. a rung that got swept.
  off: book?.own_bid != null ? Math.round((book.own_bid - mils) / 10) : null,
  sh_up: inv?.up ?? null,
  sh_dn: inv?.dn ?? null,
  pair: inv?.pairMils ?? null,
  tilt: inv?.tilt ?? null,
  unmatched_up: inv?.unmatchedUp ?? null,
  unmatched_down: inv?.unmatchedDown ?? null,
  completed_pair_count: inv?.completedPairCount ?? null,
  completed_pair_edge_usd: inv?.completedPairEdgeUsd ?? null,
  worst_case_pnl_usd: inv?.worstCasePnl ?? null,
  pair_cycle_state: inv?.pairCycleState ?? null,
});

export const makerMarkout = ({
  rid,
  fillMils,
  futureBestBidMils,
  futureMidMils,
  horizonMs,
  leg,
  roundSecond,
  inventoryState,
  pairCycleState,
}) => ({
  t: Date.now(),
  type: EventType.MARKOUT,
  rid,
  round_slug: rid,
  leg,
  fill_mils: fillMils,
  fill_price: fillMils / 1000,
  future_best_bid_mils: futureBestBidMils ?? null,
  future_mid_mils: futureMidMils ?? null,
  markout_mils:
    futureMidMils == null ? null : futureMidMils - fillMils,
  horizon_ms: horizonMs,
  sec: roundSecond,
  seconds_into_round: roundSecond,
  inventory_state: inventoryState,
  pair_cycle_state: pairCycleState,
});

export const signalSnapshot = (rid, snapshot) => ({
  t: Date.now(),
  type: EventType.SIGNAL_SNAPSHOT,
  rid,
  round_slug: rid,
  decision_time_ms: snapshot.decisionTimeMs,
  snapshot_id: snapshot.snapshotId,
  valid: snapshot.valid,
  invalid_reasons: snapshot.invalidReasons,
  snapshot,
});

export const probabilityPrediction = (rid, snapshotId, prediction) => ({
  t: Date.now(),
  type: EventType.PROBABILITY_PREDICTION,
  rid,
  round_slug: rid,
  snapshot_id: snapshotId,
  model_version: prediction.modelVersion,
  p_up: prediction.pUp,
  lower: prediction.lower,
  upper: prediction.upper,
  calibrated: prediction.calibrated,
  valid: prediction.valid,
  reasons: prediction.reasons,
});

export const actionCandidates = (rid, snapshotId, candidates) => ({
  t: Date.now(),
  type: EventType.ACTION_CANDIDATES,
  rid,
  round_slug: rid,
  snapshot_id: snapshotId,
  count: candidates.length,
  candidates,
});

export const actionSelected = (rid, snapshotId, candidate) => ({
  t: Date.now(),
  type: EventType.ACTION_SELECTED,
  rid,
  round_slug: rid,
  snapshot_id: snapshotId,
  action_candidate_id: candidate.actionCandidateId ?? null,
  candidate,
});

export const actionRejected = (rid, snapshotId, rejected) => ({
  t: Date.now(),
  type: EventType.ACTION_REJECTED,
  rid,
  round_slug: rid,
  snapshot_id: snapshotId,
  count: rejected.length,
  rejected,
});

export const v3ShadowDecision = ({
  rid,
  snapshotId,
  prediction,
  selected,
  portfolio,
  actualV2Action,
  makerSkew = null,
}) => ({
  t: Date.now(),
  type: EventType.V3_SHADOW_DECISION,
  rid,
  round_slug: rid,
  snapshot_id: snapshotId,
  model_version: prediction?.modelVersion ?? null,
  v3_action: selected,
  actual_v2_action: actualV2Action,
  portfolio,
  maker_skew: makerSkew,
  execution_blocked: true,
});

export const pairCompletionObservation = (rid, observation) => ({
  t: Date.now(),
  type: EventType.PAIR_COMPLETION_OBSERVATION,
  rid,
  round_slug: rid,
  observation,
});

export const bookSnapshot = (rid, sec, mkt, books = null) => {
  const event = {
    t: Date.now(),
    ts: Date.now() / 1000,
    type: EventType.BOOK_SNAPSHOT,
    rid,
    round_slug: rid,
    sec,
    seconds_into_round: sec,
    seconds_remaining: Math.max(0, 300 - sec),
    up_bid: mkt.up_bid,
    up_ask: mkt.up_ask,
    dn_bid: mkt.dn_bid,
    dn_ask: mkt.dn_ask,
    up_depth2: mkt.up_depth2 ?? null,
    dn_depth2: mkt.dn_depth2 ?? null,
    best_bid_up: mkt.up_bid == null ? null : mkt.up_bid / 1000,
    best_ask_up: mkt.up_ask == null ? null : mkt.up_ask / 1000,
    best_bid_down: mkt.dn_bid == null ? null : mkt.dn_bid / 1000,
    best_ask_down: mkt.dn_ask == null ? null : mkt.dn_ask / 1000,
    up_token_implied_prob:
      mkt.up_bid == null || mkt.up_ask == null
        ? null
        : (mkt.up_bid + mkt.up_ask) / 2000,
    price_to_beat: mkt.price_to_beat ?? null,
    price_to_beat_source: mkt.price_to_beat_source ?? null,
    polymarket_btc_usd: mkt.polymarket_btc_usd ?? null,
    binance_btc_usd: mkt.binance_btc_usd ?? null,
    round_volume_usdc: mkt.round_volume_usdc ?? 0,
    daily_volume_usdc: mkt.daily_volume_usdc ?? 0,
    daily_date_et: mkt.daily_date_et ?? null,
    wallet_pnl_usdc: mkt.wallet_pnl_usdc ?? null,
    market_winner: mkt.market_winner ?? null,
    net_shares_up: mkt.net_shares_up ?? null,
    net_shares_down: mkt.net_shares_down ?? null,
    last_round: mkt.last_round ?? null,
  };
  // Non-enumerable: rich activity logs stay compact. The asynchronous target
  // projector expands these immutable LegBook arrays into full books.
  if (books) Object.defineProperty(event, '_books', { value: books });
  return event;
};

/** Round resolution. Carries the outcome and the realised PnL. */
export const roundSettled = (rid, res, extra = {}) => ({
  t: Date.now(),
  ts: roundEndEpoch(rid),
  type: EventType.ROUND_SETTLED,
  rid,
  round_slug: rid,
  st: OrderStatus.SETTLED,
  outcome: res.winner,
  winner:
    res.winner === 'UP' ? 'Up' : res.winner === 'DOWN' ? 'Down' : res.winner,
  sh_up: res.upShares ?? res.legs?.UP ?? extra.shUp ?? null,
  sh_dn: res.downShares ?? res.legs?.DOWN ?? extra.shDn ?? null,
  matched: res.matchedShares,
  tilt: res.tiltShares,
  pair: res.pairCostMils,
  cost_usd: res.costUsd,
  payout_usd: res.payoutUsd,
  gross_pnl_usd: res.grossPnlUsd ?? res.pnlUsd,
  pnl_usd: res.pnlUsd,
  pnl_usdc: res.pnlUsd,
  volume_usdc: res.costUsd,
  net_shares_up:
    res.upShares ?? res.legs?.UP ?? extra.shUp ?? null,
  net_shares_down:
    res.downShares ?? res.legs?.DOWN ?? extra.shDn ?? null,
  up_avg_mils: res.upAvgMils ?? null,
  down_avg_mils: res.downAvgMils ?? null,
  fee_usd: res.feeUsd ?? extra.feeUsd ?? 0,
  fills: res.fills,
  first_sec: res.firstFillSecond ?? null,
  last_sec: res.lastFillSecond ?? null,
  placed: res.orderStats?.placed ?? null,
  cancelled: res.orderStats?.cancelled ?? null,
  churn: res.churnRatio ?? null,
});

export const redeem = (rid, { conditionId, shares, txHash, ok }) => ({
  t: Date.now(),
  type: EventType.REDEEM,
  rid,
  st: OrderStatus.REDEEMED,
  cond: conditionId,
  sh: shares,
  tx: txHash ?? null,
  ok,
});

export const halt = (reason, health) => ({
  t: Date.now(),
  type: EventType.HALT,
  reason,
  health,
});

export const health = (snapshot) => ({
  t: Date.now(),
  type: EventType.HEALTH,
  ...snapshot,
});
