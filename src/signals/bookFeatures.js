import { complementMils, tickSizeMils } from '../util.js';

function ownQuantity(ownOrders, leg, mils) {
  let total = 0;
  for (const order of ownOrders ?? []) {
    if (order?.leg === leg && Number(order.mils) === mils) {
      total += Math.max(0, Number(order.restingShares ?? order.remainingShares ?? 0) || 0);
    }
  }
  return total;
}

function subtractLevels(levels, quantityAt) {
  const output = [];
  let contaminated = false;
  let ownPresent = false;
  for (const level of levels ?? []) {
    const own = quantityAt(level.mils);
    if (own > 0) ownPresent = true;
    if (own > level.size + 0.01) contaminated = true;
    const size = Math.max(0, level.size - own);
    if (size > 0.01) output.push(Object.freeze({ mils: level.mils, size }));
  }
  return { levels: Object.freeze(output), contaminated, ownPresent };
}

/**
 * Remove our direct bid and complementary bid from a leg's public book. A
 * DOWN bid at d is economically an UP ask at 1000-d (and vice versa).
 */
export function exOwnLegBook({ leg, book, ownOrders = [] }) {
  const opposite = leg === 'UP' ? 'DOWN' : 'UP';
  const bids = subtractLevels(
    book?.bids,
    (mils) => ownQuantity(ownOrders, leg, mils)
  );
  const asks = subtractLevels(
    book?.asks,
    (mils) => ownQuantity(ownOrders, opposite, complementMils(mils))
  );
  const bestBid = bids.levels[0]?.mils ?? null;
  const bestAsk = asks.levels[0]?.mils ?? null;
  const usable = bestBid != null && bestAsk != null && bestBid < bestAsk;
  const contaminated = bids.contaminated || asks.contaminated || !usable;
  const midMils = usable ? (bestBid + bestAsk) / 2 : null;
  const spreadMils = usable ? bestAsk - bestBid : null;
  const tick = bestBid == null ? 10 : tickSizeMils(bestBid);
  const bidDepth = bestBid == null
    ? 0
    : bids.levels
        .filter((level) => level.mils >= bestBid - 2 * tick)
        .reduce((sum, level) => sum + level.size, 0);
  const askDepth = bestAsk == null
    ? 0
    : asks.levels
        .filter((level) => level.mils <= bestAsk + 2 * tick)
        .reduce((sum, level) => sum + level.size, 0);
  const depth = bidDepth + askDepth;
  return Object.freeze({
    leg,
    bids: bids.levels,
    asks: asks.levels,
    bestBid,
    bestAsk,
    midMils,
    spreadMils,
    bidDepth,
    askDepth,
    imbalance: depth > 0 ? (bidDepth - askDepth) / depth : null,
    ownQuotePresent: bids.ownPresent || asks.ownPresent,
    ownQuoteContaminated: contaminated,
  });
}

export function exOwnBookFeatures(books, ownOrders = []) {
  const up = exOwnLegBook({ leg: 'UP', book: books?.UP, ownOrders });
  const down = exOwnLegBook({ leg: 'DOWN', book: books?.DOWN, ownOrders });
  return Object.freeze({
    up,
    down,
    ownQuoteContaminated:
      up.ownQuoteContaminated || down.ownQuoteContaminated,
  });
}

