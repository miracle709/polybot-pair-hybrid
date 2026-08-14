import { roundAccounting } from './util.js';

function finite(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new RangeError(`${name} must be finite`);
  }
  return number;
}

function nonNegative(name, value) {
  const number = finite(name, value);
  if (number < 0) throw new RangeError(`${name} must be non-negative`);
  return number;
}

function probability(name, value) {
  const number = finite(name, value);
  if (number < 0 || number > 1) {
    throw new RangeError(`${name} must be in [0, 1]`);
  }
  return number;
}

/** Exact two-terminal-state payoff. Acquisition cost and fees appear once. */
export function portfolioPayoff({ qUp = 0, qDown = 0, costUsd = 0, feesUsd = 0 }) {
  const Q_UP = roundAccounting(nonNegative('qUp', qUp));
  const Q_DOWN = roundAccounting(nonNegative('qDown', qDown));
  const C = roundAccounting(nonNegative('costUsd', costUsd));
  const F = roundAccounting(nonNegative('feesUsd', feesUsd));
  const pnlIfUp = roundAccounting(Q_UP - C - F);
  const pnlIfDown = roundAccounting(Q_DOWN - C - F);
  return Object.freeze({
    qUp: Q_UP,
    qDown: Q_DOWN,
    costUsd: C,
    feesUsd: F,
    pnlIfUp,
    pnlIfDown,
    worstCasePnl: Math.min(pnlIfUp, pnlIfDown),
  });
}

/** Marginal payoff and EV for a BUY UP action. */
export function evaluateBuyUp({ shares, price, feeUsd = 0, probabilityUp }) {
  const q = nonNegative('shares', shares);
  const p = probability('price', price);
  const fee = nonNegative('feeUsd', feeUsd);
  const pi = probability('probabilityUp', probabilityUp);
  const deltaIfUp = roundAccounting(q * (1 - p) - fee);
  const deltaIfDown = roundAccounting(-q * p - fee);
  const expectedPnlDelta = roundAccounting(q * (pi - p) - fee);
  return Object.freeze({ deltaIfUp, deltaIfDown, expectedPnlDelta });
}

/** Marginal payoff and EV for a BUY DOWN action. */
export function evaluateBuyDown({ shares, price, feeUsd = 0, probabilityUp }) {
  const q = nonNegative('shares', shares);
  const p = probability('price', price);
  const fee = nonNegative('feeUsd', feeUsd);
  const pi = probability('probabilityUp', probabilityUp);
  const deltaIfUp = roundAccounting(-q * p - fee);
  const deltaIfDown = roundAccounting(q * (1 - p) - fee);
  const expectedPnlDelta = roundAccounting(q * ((1 - pi) - p) - fee);
  return Object.freeze({ deltaIfUp, deltaIfDown, expectedPnlDelta });
}

/** Deterministic equal-outcome payoff from one UP+DOWN complete set. */
export function evaluatePair({ shares, upPrice, downPrice, executionCostsUsd = 0 }) {
  const q = nonNegative('shares', shares);
  const pUp = probability('upPrice', upPrice);
  const pDown = probability('downPrice', downPrice);
  const costs = nonNegative('executionCostsUsd', executionCostsUsd);
  const pairDelta = roundAccounting(q * (1 - pUp - pDown) - costs);
  return Object.freeze({
    deltaIfUp: pairDelta,
    deltaIfDown: pairDelta,
    expectedPnlDelta: pairDelta,
    pairDelta,
  });
}

/** Apply a BUY marginal result to an authoritative portfolio state. */
export function portfolioAfterBuy(portfolio, { leg, shares, price, feeUsd = 0 }) {
  const before = portfolioPayoff(portfolio);
  const q = nonNegative('shares', shares);
  const p = probability('price', price);
  const fee = nonNegative('feeUsd', feeUsd);
  if (leg !== 'UP' && leg !== 'DOWN') {
    throw new RangeError(`leg must be UP or DOWN, got ${leg}`);
  }
  return portfolioPayoff({
    qUp: before.qUp + (leg === 'UP' ? q : 0),
    qDown: before.qDown + (leg === 'DOWN' ? q : 0),
    costUsd: before.costUsd + q * p,
    feesUsd: before.feesUsd + fee,
  });
}

export function portfolioFromInventory(inventory) {
  return portfolioPayoff({
    qUp: inventory.shares('UP'),
    qDown: inventory.shares('DOWN'),
    costUsd: inventory.totalNotionalUsd(),
    feesUsd: inventory.totalFeeUsd(),
  });
}
