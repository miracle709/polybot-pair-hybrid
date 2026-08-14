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

export function createActionCandidate(input) {
  if (!ACTION_TYPES.has(input?.type)) {
    throw new RangeError(`unknown action type ${input?.type}`);
  }
  if (input.type !== ActionType.NO_ACTION) requireStrategyIntent(input.intent);
  return Object.freeze({
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
    pairInteraction: input.pairInteraction ?? null,
    signalSnapshotId: input.signalSnapshotId ?? null,
    predictedProbability: input.predictedProbability ?? null,
    probabilityLower: input.probabilityLower ?? null,
    probabilityUpper: input.probabilityUpper ?? null,
    executionType: input.executionType ?? null,
    reasons: Object.freeze([...(input.reasons ?? [])]),
    eligible: Boolean(input.eligible),
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

