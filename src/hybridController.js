import {
  ActionType,
  createActionCandidate,
  noActionCandidate,
} from './actions/actionCandidate.js';
import { analyzePairInteraction } from './actions/pairInteraction.js';
import { ExecutionType, executionFeeUsd } from './fees.js';
import {
  evaluateBuyDown,
  evaluateBuyUp,
  portfolioAfterBuy,
  portfolioFromInventory,
  portfolioPayoff,
} from './portfolioMath.js';
import { StrategyIntent } from './strategyIntent.js';
import { minimumOrderSharesForParams } from './orderConstraints.js';
import { SourceQuality } from './signals/sourceQuality.js';
import { StaticExecutionReserveModel } from './models/executionReserveModel.js';

function unique(values) {
  return [...new Set(values)];
}

function sizeGrid(minimum, maximum, step) {
  if (!(maximum >= minimum)) return [];
  const output = [];
  for (let size = minimum; size <= maximum + 1e-9; size += step) {
    output.push(Math.round(size * 1e6) / 1e6);
  }
  if (output.at(-1) !== maximum) output.push(maximum);
  return unique(output);
}

function totalAfterTwoBuys(before, up, down) {
  return portfolioPayoff({
    qUp: before.qUp + up.shares,
    qDown: before.qDown + down.shares,
    costUsd:
      before.costUsd +
      (up.shares * up.priceMils) / 1000 +
      (down.shares * down.priceMils) / 1000,
    feesUsd: before.feesUsd + up.costsUsd + down.costsUsd,
  });
}

function candidateSort(a, b) {
  return (
    b.robustExpectedPnlDelta - a.robustExpectedPnlDelta ||
    b.expectedPnlDelta - a.expectedPnlDelta ||
    a.capitalRequired - b.capitalRequired ||
    String(a.actionCandidateId).localeCompare(String(b.actionCandidateId))
  );
}

export class HybridController {
  constructor({ params, guards, executionReserveModel = null }) {
    this.params = params;
    this.guards = guards;
    this.executionReserveModel = executionReserveModel ??
      new StaticExecutionReserveModel({
        makerBps: params.DIRECTIONAL_MAKER_RESERVE_BPS,
        takerBps: params.DIRECTIONAL_TAKER_RESERVE_BPS,
      });
  }

  decide({
    inventory,
    books,
    signalSnapshot,
    probability,
    pairRegime,
    v2Decision = null,
    ownOrders = [],
  }) {
    const portfolio = portfolioFromInventory(inventory);
    const candidates = [
      ...this.#pairCandidates({ inventory, portfolio, v2Decision, signalSnapshot, probability, pairRegime }),
      ...this.#directionalCandidates({ inventory, portfolio, signalSnapshot, probability, pairRegime }),
      ...this.#riskReductionCandidates({ inventory, portfolio, signalSnapshot, probability, pairRegime }),
    ];
    const staleDirectionalOrders = ownOrders.filter(
      (order) => order.strategyIntent === StrategyIntent.DIRECTIONAL
    );
    if (!signalSnapshot?.valid && staleDirectionalOrders.length > 0) {
      candidates.push(createActionCandidate({
        type: ActionType.CANCEL_STALE,
        intent: StrategyIntent.PROTECTION,
        shares: 0,
        robustExpectedPnlDelta: 0,
        expectedPnlDelta: 0,
        capitalRequired: 0,
        riskDelta: 0,
        pnlIfUpAfter: portfolio.pnlIfUp,
        pnlIfDownAfter: portfolio.pnlIfDown,
        worstCasePnlAfter: portfolio.worstCasePnl,
        signalSnapshotId: signalSnapshot?.snapshotId ?? null,
        modelVersion: probability?.modelVersion ?? null,
        reasons: [
          'directional_inputs_invalid',
          ...(signalSnapshot?.invalidReasons ?? []),
        ],
        eligible: true,
        executionAuthorized: false,
        roundRegime: pairRegime,
      }));
    }
    const noAction = noActionCandidate();
    candidates.push(noAction);

    const eligible = candidates.filter((candidate) => candidate.eligible);
    let selected = null;
    const pairCompletions = eligible
      .filter((candidate) => candidate.type === ActionType.PAIR_COMPLETE)
      .sort(candidateSort);
    if (!this.params.ALLOW_MODEL_TO_DEFER_PAIR_COMPLETION && pairCompletions.length) {
      selected = pairCompletions[0];
    }
    if (!selected) {
      const cancellations = eligible.filter((candidate) => candidate.type === ActionType.CANCEL_STALE);
      if (cancellations.length) selected = cancellations[0];
    }
    if (!selected) {
      selected = eligible
        .filter((candidate) => candidate.type !== ActionType.NO_ACTION)
        .filter((candidate) => candidate.robustExpectedPnlDelta > 0)
        .sort(candidateSort)[0] ?? noAction;
    }
    return Object.freeze({
      selected,
      candidates: Object.freeze(candidates),
      rejected: Object.freeze(candidates.filter((candidate) => !candidate.eligible)),
      portfolio,
      signalSnapshotId: signalSnapshot?.snapshotId ?? null,
      modelVersion: probability?.modelVersion ?? null,
      shadowOnly: Boolean(this.params.V3_SHADOW_ONLY),
    });
  }

  #fee(executionType, shares, price) {
    return executionFeeUsd({
      executionType,
      shares,
      price,
      makerBps: this.params.V3_MAKER_FEE_BPS,
      takerFeeRate: this.params.POLYMARKET_TAKER_FEE_RATE,
      builderFeeBps: this.params.V3_BUILDER_FEE_BPS,
    });
  }

  #pairCandidates({ inventory, portfolio, v2Decision, signalSnapshot, probability, pairRegime }) {
    const rungs = v2Decision?.rungs ?? [];
    const output = [];
    for (const rung of rungs) {
      const oppositeShares = inventory.unmatchedShares(rung.leg === 'UP' ? 'DOWN' : 'UP');
      if (!(oppositeShares > 0)) continue;
      const shares = Math.min(Number(rung.shares), oppositeShares);
      const interaction = analyzePairInteraction({
        inventory,
        leg: rung.leg,
        shares,
        priceMils: rung.mils,
        pairHardMaxMils: this.params.PAIR_HARD_MAX_MILS,
        allowNegativePairLock: this.params.ALLOW_NEGATIVE_PAIR_LOCK,
      });
      const price = rung.mils / 1000;
      const fee = this.#fee(ExecutionType.MAKER, shares, price);
      const reserve = shares * (this.params.PAIR_EXECUTION_BUFFER_MILS / 1000);
      const deterministicEdge = interaction.pairs.reduce(
        (sum, pair) => sum + pair.shares * (1 - pair.pairMils / 1000),
        0
      );
      const after = portfolioAfterBuy(portfolio, {
        leg: rung.leg,
        shares,
        price,
        feeUsd: fee + reserve,
      });
      const robust = deterministicEdge - fee - reserve;
      const reasons = [];
      if (!interaction.eligible) reasons.push('pair_hard_max');
      if (!(robust > 0)) reasons.push('non_positive_deterministic_pair_ev');
      output.push(createActionCandidate({
        type: ActionType.PAIR_COMPLETE,
        intent: StrategyIntent.PAIR_COMPLETE,
        leg: rung.leg,
        shares,
        limitMils: rung.mils,
        expectedFillPriceMils: rung.mils,
        expectedFeeUsd: fee,
        expectedExecutionReserveUsd: reserve,
        pnlIfUpAfter: after.pnlIfUp,
        pnlIfDownAfter: after.pnlIfDown,
        worstCasePnlAfter: after.worstCasePnl,
        expectedPnlDelta: deterministicEdge - fee,
        robustExpectedPnlDelta: robust,
        capitalRequired: shares * price + fee,
        riskDelta: after.worstCasePnl - portfolio.worstCasePnl,
        pairInteraction: interaction,
        signalSnapshotId: signalSnapshot?.snapshotId ?? null,
        predictedProbability: probability?.pUp ?? null,
        probabilityLower: probability?.lower ?? null,
        probabilityUpper: probability?.upper ?? null,
        modelVersion: probability?.modelVersion ?? null,
        executionType: ExecutionType.MAKER,
        expectedEdgeAtDecision: robust,
        roundRegime: pairRegime,
        executionAuthorized: false,
        reasons,
        eligible: reasons.length === 0,
      }));
    }

    const inventoryIsNeutral =
      inventory.unmatchedShares('UP') === 0 &&
      inventory.unmatchedShares('DOWN') === 0;
    const upRung = inventoryIsNeutral
      ? rungs.find((rung) => rung.leg === 'UP')
      : null;
    const downRung = inventoryIsNeutral
      ? rungs.find((rung) => rung.leg === 'DOWN')
      : null;
    if (upRung && downRung) {
      const shares = Math.min(upRung.shares, downRung.shares);
      const upPrice = upRung.mils / 1000;
      const downPrice = downRung.mils / 1000;
      const upFee = this.#fee(ExecutionType.MAKER, shares, upPrice);
      const downFee = this.#fee(ExecutionType.MAKER, shares, downPrice);
      const reserve = shares * (this.params.PAIR_EXECUTION_BUFFER_MILS / 1000);
      const gross = shares * (1 - upPrice - downPrice);
      const robust = gross - upFee - downFee - reserve;
      const after = totalAfterTwoBuys(portfolio,
        { shares, priceMils: upRung.mils, costsUsd: upFee + reserve / 2 },
        { shares, priceMils: downRung.mils, costsUsd: downFee + reserve / 2 });
      const pairMils = upRung.mils + downRung.mils;
      const reasons = [];
      if (pairMils > this.params.PAIR_HARD_MAX_MILS) reasons.push('pair_hard_max');
      if (!(robust > 0)) reasons.push('non_positive_deterministic_pair_ev');
      output.push(createActionCandidate({
        type: ActionType.PAIR_OPEN,
        intent: StrategyIntent.PAIR_OPEN,
        shares,
        expectedFeeUsd: upFee + downFee,
        expectedExecutionReserveUsd: reserve,
        pnlIfUpAfter: after.pnlIfUp,
        pnlIfDownAfter: after.pnlIfDown,
        worstCasePnlAfter: after.worstCasePnl,
        expectedPnlDelta: gross - upFee - downFee,
        robustExpectedPnlDelta: robust,
        capitalRequired: shares * (upPrice + downPrice) + upFee + downFee,
        riskDelta: after.worstCasePnl - portfolio.worstCasePnl,
        pairInteraction: {
          pairMils,
          shares,
          requiresBothFills: true,
          completionModelValidated: false,
        },
        signalSnapshotId: signalSnapshot?.snapshotId ?? null,
        predictedProbability: probability?.pUp ?? null,
        probabilityLower: probability?.lower ?? null,
        probabilityUpper: probability?.upper ?? null,
        modelVersion: probability?.modelVersion ?? null,
        executionType: ExecutionType.MAKER,
        expectedEdgeAtDecision: robust,
        orders: [
          { leg: 'UP', shares, limitMils: upRung.mils },
          { leg: 'DOWN', shares, limitMils: downRung.mils },
        ],
        roundRegime: pairRegime,
        executionAuthorized: false,
        reasons,
        eligible: reasons.length === 0,
      }));
    }
    return output;
  }

  #directionalCandidates({ inventory, portfolio, signalSnapshot, probability, pairRegime }) {
    const output = [];
    for (const executionType of [ExecutionType.MAKER, ExecutionType.TAKER]) {
      for (const leg of ['UP', 'DOWN']) {
        const price = executionType === ExecutionType.MAKER
          ? leg === 'UP' ? signalSnapshot?.upBestBid : signalSnapshot?.downBestBid
          : leg === 'UP' ? signalSnapshot?.upBestAsk : signalSnapshot?.downBestAsk;
        if (!(price > 0 && price < 1)) continue;
        const priceMils = Math.round(price * 1000);
        const minimum = minimumOrderSharesForParams(priceMils, this.params);
        let maximum = Number(this.params.MAX_DIRECTIONAL_SHARES);
        const sec = Number(signalSnapshot?.roundSecond);
        if (Number.isFinite(sec) && sec >= this.params.DIRECTIONAL_REDUCE_START_SECONDS) {
          maximum *= this.params.DIRECTIONAL_LATE_SIZE_FRACTION;
        }
        const step = Math.max(0.000001, Number(this.params.DIRECTIONAL_SIZE_STEP_SHARES));
        for (const shares of sizeGrid(minimum, maximum, step)) {
          output.push(this.#directionalCandidate({
            inventory,
            portfolio,
            signalSnapshot,
            probability,
            pairRegime,
            leg,
            executionType,
            shares,
            price,
            priceMils,
          }));
        }
      }
    }
    return output;
  }

  #directionalCandidate({
    inventory,
    portfolio,
    signalSnapshot,
    probability,
    pairRegime,
    leg,
    executionType,
    shares,
    price,
    priceMils,
  }) {
    const fee = this.#fee(executionType, shares, price);
    const reserve = this.executionReserveModel.reserveUsd({
      executionType,
      shares,
      price,
      leg,
      snapshot: signalSnapshot,
    });
    const evaluator = leg === 'UP' ? evaluateBuyUp : evaluateBuyDown;
    const point = evaluator({ shares, price, feeUsd: fee, probabilityUp: probability?.pUp ?? 0.5 });
    const robustProbability = leg === 'UP'
      ? probability?.lower ?? 0
      : 1 - (probability?.upper ?? 1);
    const robust = shares * (robustProbability - price) - fee - reserve;
    const after = portfolioAfterBuy(portfolio, {
      leg,
      shares,
      price,
      feeUsd: fee + reserve,
    });
    const interaction = analyzePairInteraction({
      inventory,
      leg,
      shares,
      priceMils,
      pairHardMaxMils: this.params.PAIR_HARD_MAX_MILS,
      allowNegativePairLock: false,
    });
    const directionalSharesAfter = Math.abs(after.qUp - after.qDown);
    const totalNotionalAfter = after.costUsd;
    const reasons = [];
    if (!signalSnapshot?.valid) reasons.push('signal_snapshot_invalid');
    if (!probability?.valid) reasons.push('probability_invalid');
    if (!probability?.calibrated) reasons.push('model_uncalibrated');
    if (signalSnapshot?.priceToBeatSourceQuality !== SourceQuality.AUTHORITATIVE) {
      reasons.push('price_to_beat_not_authoritative');
    }
    if (signalSnapshot?.settlementReferenceSourceQuality !== SourceQuality.AUTHORITATIVE) {
      reasons.push('settlement_reference_not_authoritative');
    }
    if (!interaction.eligible) reasons.push('pair_hard_max');
    if (after.worstCasePnl < -this.params.MAX_DIRECTIONAL_LOSS_USD) {
      reasons.push('max_directional_loss');
    }
    if (directionalSharesAfter > this.params.MAX_DIRECTIONAL_SHARES) {
      reasons.push('max_directional_shares');
    }
    if (totalNotionalAfter > this.guards.MAX_ROUND_NOTIONAL_USD.hardLimit) {
      reasons.push('max_round_notional');
    }
    const threshold = executionType === ExecutionType.TAKER
      ? this.params.MIN_DIRECTIONAL_TAKER_ROBUST_EV_USD
      : this.params.MIN_DIRECTIONAL_ROBUST_EV_USD;
    if (robust < threshold) reasons.push('robust_ev_below_threshold');
    const sec = Number(signalSnapshot?.roundSecond);
    if (!Number.isFinite(sec) || sec < this.params.PAIR_DISCOVERY_START_SECONDS) {
      reasons.push('directional_regime_closed');
    } else if (sec >= this.params.DIRECTIONAL_STOP_NEW_SECONDS) {
      reasons.push('directional_regime_closed');
    } else if (
      sec >= this.params.DIRECTIONAL_STRONG_ONLY_START_SECONDS &&
      robust < this.params.MIN_DIRECTIONAL_STRONG_ROBUST_EV_USD
    ) {
      reasons.push('late_round_edge_too_weak');
    }
    if (executionType === ExecutionType.TAKER) {
      const available = leg === 'UP'
        ? signalSnapshot?.depthFeatures?.upAsk
        : signalSnapshot?.depthFeatures?.downAsk;
      if (!Number.isFinite(available) || shares > available * this.params.MAX_TAKER_DEPTH_FRACTION) {
        reasons.push('insufficient_taker_depth');
      }
    }
    const activeExecution = !this.params.V3_SHADOW_ONLY && this.params.DIRECTIONAL_ENABLED;
    if (!this.params.V3_SHADOW_ONLY && !this.params.DIRECTIONAL_ENABLED) {
      reasons.push('directional_disabled');
    }
    if (activeExecution && executionType === ExecutionType.MAKER && !this.params.DIRECTIONAL_MAKER_ENABLED) {
      reasons.push('directional_maker_disabled');
    }
    if (activeExecution && executionType === ExecutionType.TAKER && !this.params.DIRECTIONAL_TAKER_ENABLED) {
      reasons.push('directional_taker_disabled');
    }
    const type = leg === 'UP'
      ? executionType === ExecutionType.MAKER ? ActionType.DIRECTIONAL_UP_MAKER : ActionType.DIRECTIONAL_UP_TAKER
      : executionType === ExecutionType.MAKER ? ActionType.DIRECTIONAL_DOWN_MAKER : ActionType.DIRECTIONAL_DOWN_TAKER;
    return createActionCandidate({
      type,
      intent: StrategyIntent.DIRECTIONAL,
      leg,
      shares,
      limitMils: priceMils,
      expectedFillPriceMils: priceMils,
      expectedFeeUsd: fee,
      expectedExecutionReserveUsd: reserve,
      pnlIfUpAfter: after.pnlIfUp,
      pnlIfDownAfter: after.pnlIfDown,
      worstCasePnlAfter: after.worstCasePnl,
      expectedPnlDelta: point.expectedPnlDelta,
      robustExpectedPnlDelta: robust,
      capitalRequired: shares * price + fee + reserve,
      riskDelta: after.worstCasePnl - portfolio.worstCasePnl,
      pairInteraction: interaction,
      signalSnapshotId: signalSnapshot?.snapshotId ?? null,
      predictedProbability: probability?.pUp ?? null,
      probabilityLower: probability?.lower ?? null,
      probabilityUpper: probability?.upper ?? null,
      modelVersion: probability?.modelVersion ?? null,
      executionType,
      expectedEdgeAtDecision: robust,
      roundRegime: pairRegime,
      executionAuthorized: activeExecution && reasons.length === 0,
      reasons: unique(reasons),
      eligible: reasons.length === 0,
    });
  }

  #riskReductionCandidates({ inventory, portfolio, signalSnapshot, probability, pairRegime }) {
    const tilt = inventory.shares('UP') - inventory.shares('DOWN');
    if (Math.abs(tilt) < this.params.MIN_RUNG_SHARES) return [];
    const leg = tilt > 0 ? 'DOWN' : 'UP';
    const price = leg === 'UP' ? signalSnapshot?.upBestAsk : signalSnapshot?.downBestAsk;
    if (!(price > 0 && price < 1)) return [];
    const shares = Math.min(Math.abs(tilt), this.params.MAX_DIRECTIONAL_SHARES);
    const priceMils = Math.round(price * 1000);
    const minimum = minimumOrderSharesForParams(priceMils, this.params);
    if (shares < minimum) return [];
    const fee = this.#fee(ExecutionType.TAKER, shares, price);
    const reserve = this.executionReserveModel.reserveUsd({
      executionType: ExecutionType.TAKER,
      shares,
      price,
      leg,
      snapshot: signalSnapshot,
    });
    const after = portfolioAfterBuy(portfolio, { leg, shares, price, feeUsd: fee + reserve });
    const interaction = analyzePairInteraction({
      inventory,
      leg,
      shares,
      priceMils,
      pairHardMaxMils: this.params.PAIR_HARD_MAX_MILS,
      allowNegativePairLock: this.params.ALLOW_NEGATIVE_PAIR_LOCK,
    });
    const point = (leg === 'UP' ? evaluateBuyUp : evaluateBuyDown)({
      shares,
      price,
      feeUsd: fee,
      probabilityUp: probability?.pUp ?? 0.5,
    });
    const reasons = [];
    if (!interaction.eligible) reasons.push('negative_pair_lock_disabled');
    if (after.worstCasePnl <= portfolio.worstCasePnl) reasons.push('risk_not_reduced');
    return [createActionCandidate({
      type: ActionType.RISK_REDUCTION,
      intent: StrategyIntent.RISK_REDUCTION,
      leg,
      shares,
      limitMils: priceMils,
      expectedFillPriceMils: priceMils,
      expectedFeeUsd: fee,
      expectedExecutionReserveUsd: reserve,
      pnlIfUpAfter: after.pnlIfUp,
      pnlIfDownAfter: after.pnlIfDown,
      worstCasePnlAfter: after.worstCasePnl,
      expectedPnlDelta: point.expectedPnlDelta,
      robustExpectedPnlDelta: point.expectedPnlDelta - reserve,
      capitalRequired: shares * price + fee + reserve,
      riskDelta: after.worstCasePnl - portfolio.worstCasePnl,
      pairInteraction: interaction,
      signalSnapshotId: signalSnapshot?.snapshotId ?? null,
      predictedProbability: probability?.pUp ?? null,
      probabilityLower: probability?.lower ?? null,
      probabilityUpper: probability?.upper ?? null,
      modelVersion: probability?.modelVersion ?? null,
      executionType: ExecutionType.TAKER,
      expectedEdgeAtDecision: point.expectedPnlDelta - reserve,
      roundRegime: pairRegime,
      executionAuthorized: false,
      reasons,
      eligible: reasons.length === 0,
    })];
  }
}
