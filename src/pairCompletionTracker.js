function contextFromSnapshot(snapshot) {
  return Object.freeze({
    signalSnapshotId: snapshot?.snapshotId ?? null,
    gapBps: snapshot?.rawGapBps ?? null,
    volatility: snapshot?.realizedVolatility ?? null,
    spread: snapshot?.spread ?? null,
    depth: snapshot?.depthFeatures ?? null,
    clobReturn3sBps: snapshot?.clobReturn3sBps ?? null,
  });
}

/**
 * Observational first-fill tracker. It never feeds back into V2 quoting.
 * Callers receive immutable start/completion/settlement records for JSONL.
 */
export class PairCompletionTracker {
  constructor({
    roundSlug,
    horizonsSeconds = [5, 15, 30, 60],
    onObservation = () => {},
  }) {
    this.roundSlug = roundSlug;
    this.horizonsSeconds = Object.freeze([...horizonsSeconds]);
    this.onObservation = onObservation;
    this.pending = [];
    this.completed = [];
  }

  start({ lot, shares, roundSecond, snapshot = null }) {
    if (!(Number(shares) > 0)) return null;
    const observation = {
      observationId: `${lot.id}:first:${roundSecond}`,
      roundSlug: this.roundSlug,
      status: 'FIRST_FILL',
      firstLeg: lot.leg,
      firstFillMils: Number(lot.priceMils ?? lot.mils),
      firstFillShares: Number(shares),
      remainingShares: Number(shares),
      firstFillSecond: Number(roundSecond),
      firstFillTimeMs: Number(lot.ts) * 1000,
      context: contextFromSnapshot(snapshot),
      bestComplementPriceMils: null,
      bestComplementPricePath: [],
    };
    this.pending.push(observation);
    this.#emit(observation);
    return observation.observationId;
  }

  observeBook({ books, roundSecond }) {
    for (const observation of this.pending) {
      const complementLeg = observation.firstLeg === 'UP' ? 'DOWN' : 'UP';
      const priceMils = books?.[complementLeg]?.bestAsk ?? null;
      if (priceMils == null) continue;
      observation.bestComplementPriceMils = observation.bestComplementPriceMils == null
        ? priceMils
        : Math.min(observation.bestComplementPriceMils, priceMils);
      const last = observation.bestComplementPricePath.at(-1);
      if (!last || last.priceMils !== priceMils) {
        observation.bestComplementPricePath.push(Object.freeze({
          roundSecond: Number(roundSecond),
          priceMils,
        }));
        if (observation.bestComplementPricePath.length > 64) {
          observation.bestComplementPricePath.shift();
        }
      }
    }
  }

  complete({ complementLeg, shares, priceMils, roundSecond, snapshot = null }) {
    let remaining = Number(shares);
    const completedRecords = [];
    for (let i = 0; i < this.pending.length && remaining > 0;) {
      const observation = this.pending[i];
      const expectedLeg = observation.firstLeg === 'UP' ? 'DOWN' : 'UP';
      if (expectedLeg !== complementLeg) {
        i += 1;
        continue;
      }
      const matched = Math.min(remaining, observation.remainingShares);
      observation.remainingShares -= matched;
      remaining -= matched;
      const elapsedSeconds = Number(roundSecond) - observation.firstFillSecond;
      const record = {
        ...observation,
        status: 'COMPLEMENT_FILLED',
        completedShares: matched,
        complementLeg,
        complementFillMils: Number(priceMils),
        pairMils: observation.firstFillMils + Number(priceMils),
        complementFillSecond: Number(roundSecond),
        timeToComplementSeconds: elapsedSeconds,
        completionByHorizon: Object.freeze(Object.fromEntries(
          [
            ...this.horizonsSeconds.map((horizon) => [String(horizon), elapsedSeconds <= horizon]),
            ['remaining_round', true],
          ]
        )),
        completionContext: contextFromSnapshot(snapshot),
        bestComplementPricePath: Object.freeze([...observation.bestComplementPricePath]),
      };
      this.completed.push(record);
      completedRecords.push(record);
      this.#emit(record);
      if (observation.remainingShares <= 1e-9) this.pending.splice(i, 1);
      else i += 1;
    }
    return Object.freeze(completedRecords);
  }

  settle(winner, roundSecond) {
    for (const observation of [...this.completed, ...this.pending]) {
      this.#emit({
        ...observation,
        status: 'SETTLED',
        finalOutcome: winner,
        settledSecond: Number(roundSecond),
        complementFilled: observation.status === 'COMPLEMENT_FILLED',
        completionByHorizon:
          observation.completionByHorizon ??
          Object.freeze(Object.fromEntries([
            ...this.horizonsSeconds.map((horizon) => [String(horizon), false]),
            ['remaining_round', false],
          ])),
      });
    }
  }

  #emit(observation) {
    const frozen = Object.freeze({
      ...observation,
      bestComplementPricePath: Object.freeze([
        ...(observation.bestComplementPricePath ?? []),
      ]),
    });
    this.onObservation(frozen);
  }
}
