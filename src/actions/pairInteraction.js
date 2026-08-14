function requireLeg(leg) {
  if (leg !== 'UP' && leg !== 'DOWN') throw new RangeError(`unknown leg ${leg}`);
  return leg;
}

/** Pure FIFO preview. Strategy intent cannot alter physical complete sets. */
export function analyzePairInteraction({
  inventory,
  leg,
  shares,
  priceMils,
  pairHardMaxMils,
  allowNegativePairLock = false,
}) {
  const buyLeg = requireLeg(leg);
  const quantity = Number(shares);
  const price = Number(priceMils);
  const hardMax = Number(pairHardMaxMils);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new RangeError('shares must be positive');
  if (!Number.isFinite(price) || price < 1 || price > 999) throw new RangeError('priceMils invalid');
  if (!Number.isFinite(hardMax) || hardMax <= 0 || hardMax > 1000) {
    throw new RangeError('pairHardMaxMils invalid');
  }
  const oppositeLots = buyLeg === 'UP'
    ? inventory?.unmatchedDownLots ?? []
    : inventory?.unmatchedUpLots ?? [];
  let remaining = quantity;
  const pairs = [];
  for (const lot of oppositeLots) {
    if (remaining <= 0) break;
    const matched = Math.min(remaining, Number(lot.remainingShares));
    if (!(matched > 0)) continue;
    const pairMils = price + Number(lot.priceMils ?? lot.mils);
    pairs.push(Object.freeze({
      oppositeLotId: lot.id,
      oppositeLeg: lot.leg,
      oppositeIntent: lot.strategyIntent ?? lot.intent ?? null,
      shares: matched,
      buyMils: price,
      oppositeMils: Number(lot.priceMils ?? lot.mils),
      pairMils,
      withinHardMax: pairMils <= hardMax,
      negativePair: pairMils > 1000,
    }));
    remaining -= matched;
  }
  const sharesCompleting = quantity - remaining;
  const violatesHardMax = pairs.some((pair) => !pair.withinHardMax);
  const createsNegativePair = pairs.some((pair) => pair.negativePair);
  return Object.freeze({
    buyLeg,
    proposedShares: quantity,
    sharesCompleting,
    directionalResidualShares: remaining,
    pairs: Object.freeze(pairs),
    worstPairMils: pairs.length ? Math.max(...pairs.map((pair) => pair.pairMils)) : null,
    violatesHardMax,
    createsNegativePair,
    eligible:
      !violatesHardMax && (allowNegativePairLock || !createsNegativePair),
  });
}

