import { requireStrategyIntent } from '../strategyIntent.js';

export const ActionType = Object.freeze({
  NO_ACTION: 'NO_ACTION',
  PAIR_OPEN: 'PAIR_OPEN',
  PAIR_COMPLETE: 'PAIR_COMPLETE',
  DIRECTIONAL_UP_MAKER: 'DIRECTIONAL_UP_MAKER',
  DIRECTIONAL_DOWN_MAKER: 'DIRECTIONAL_DOWN_MAKER',
  DIRECTIONAL_UP_TAKER: 'DIRECTIONAL_UP_TAKER',
  DIRECTIONAL_DOWN_TAKER: 'DIRECTIONAL_DOWN_TAKER',
  RISK_REDUCTION: 'RISK_REDUCTION',
  CANCEL_STALE: 'CANCEL_STALE',
});

const ACTION_TYPES = new Set(Object.values(ActionType));

function freezeValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeValue));
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = freezeValue(item);
    return Object.freeze(copy);
  }
  return value;
}

function candidateId(input) {
  return input.actionCandidateId ?? [
    input.type,
    input.signalSnapshotId ?? 'no-signal',
    input.leg ?? 'BOTH',
    Number(input.shares ?? 0),
    input.limitMils ?? input.expectedFillPriceMils ?? 'na',
    input.executionType ?? 'na',
  ].join(':');
}

export function createActionCandidate(input) {
  if (!ACTION_TYPES.has(input?.type)) {
    throw new RangeError(`unknown action type ${input?.type}`);
  }
  if (input.type !== ActionType.NO_ACTION) requireStrategyIntent(input.intent);
  const base = {
    type: input.type,
    intent: input.intent ?? null,
    leg: input.leg ?? null,
    shares: Number(input.shares ?? 0),
    limitMils: input.limitMils ?? null,
    expectedFillPriceMils: input.expectedFillPriceMils ?? null,
    expectedFeeUsd: Number(input.expectedFeeUsd ?? 0),
    pnlIfUpAfter: input.pnlIfUpAfter ?? null,
    pnlIfDownAfter: input.pnlIfDownAfter ?? null,
    worstCasePnlAfter: input.worstCasePnlAfter ?? null,
    expectedPnlDelta: Number(input.expectedPnlDelta ?? 0),
    robustExpectedPnlDelta: Number(input.robustExpectedPnlDelta ?? 0),
    capitalRequired: Number(input.capitalRequired ?? 0),
    riskDelta: Number(input.riskDelta ?? 0),
    pairInteraction: freezeValue(input.pairInteraction ?? null),
    signalSnapshotId: input.signalSnapshotId ?? null,
    predictedProbability: input.predictedProbability ?? null,
    probabilityLower: input.probabilityLower ?? null,
    probabilityUpper: input.probabilityUpper ?? null,
    executionType: input.executionType ?? null,
    reasons: Object.freeze([...(input.reasons ?? [])]),
    eligible: Boolean(input.eligible),
  };
  // Preserve the compact legacy NO_ACTION record while requiring complete
  // provenance and economics on every actionable candidate.
  if (input.type === ActionType.NO_ACTION) return Object.freeze(base);
  return Object.freeze({
    actionCandidateId: candidateId(input),
    ...base,
    pUp: input.predictedProbability ?? null,
    expectedExecutionReserveUsd: Number(input.expectedExecutionReserveUsd ?? 0),
    modelVersion: input.modelVersion ?? null,
    expectedEdgeAtDecision: input.expectedEdgeAtDecision ?? null,
    orders: freezeValue(input.orders ?? null),
    roundRegime: input.roundRegime ?? null,
    executionAuthorized: Boolean(input.executionAuthorized),
  });
}

export function noActionCandidate(reasons = []) {
  return createActionCandidate({
    type: ActionType.NO_ACTION,
    expectedPnlDelta: 0,
    robustExpectedPnlDelta: 0,
    reasons,
    eligible: true,
  });
}
