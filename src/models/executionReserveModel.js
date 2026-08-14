export class ExecutionReserveModel {
  // eslint-disable-next-line no-unused-vars
  reserveUsd(actionState) {
    throw new Error('ExecutionReserveModel.reserveUsd not implemented');
  }
}

/** Compatibility reserve used until markout coverage is sufficient. */
export class StaticExecutionReserveModel extends ExecutionReserveModel {
  constructor({ makerBps = 0, takerBps = 0 } = {}) {
    super();
    this.makerBps = Number(makerBps);
    this.takerBps = Number(takerBps);
  }
  reserveUsd({ executionType, shares, price }) {
    const bps = executionType === 'TAKER' ? this.takerBps : this.makerBps;
    return Number(shares) * Number(price) * (bps / 10_000);
  }
}

/**
 * Applies offline conditional adverse-markout quantiles. The artifact is never
 * fitted or updated on the hot path and falls back to the static reserve unless
 * chronological validation and a sufficiently populated bucket are present.
 */
export class EmpiricalExecutionReserveModel extends ExecutionReserveModel {
  constructor({ artifact, fallback, minimumBucketSamples = 200 } = {}) {
    super();
    this.artifact = artifact ?? null;
    this.fallback = fallback ?? new StaticExecutionReserveModel();
    this.minimumBucketSamples = minimumBucketSamples;
  }

  reserveUsd(actionState) {
    const validation = this.artifact?.validation ?? {};
    const quantile = Number(validation.quantile);
    if (
      validation.walkForward !== true ||
      validation.noLookAhead !== true ||
      !Number.isFinite(quantile) ||
      quantile <= 0.5 ||
      quantile > 1
    ) return this.fallback.reserveUsd(actionState);
    const key = this.#bucketKey(actionState);
    const bucket = this.artifact?.buckets?.[key] ?? null;
    if (
      !bucket ||
      Number(bucket.sampleCount) < this.minimumBucketSamples ||
      !Number.isFinite(Number(bucket.adverseMoveMilsPerShare)) ||
      Number(bucket.adverseMoveMilsPerShare) < 0
    ) return this.fallback.reserveUsd(actionState);
    return (
      Number(actionState.shares) *
      Number(bucket.adverseMoveMilsPerShare) /
      1000
    );
  }

  #bucketKey({ executionType, leg, snapshot }) {
    const sec = Number(snapshot?.roundSecond);
    const volBps = Number(snapshot?.remainingVolatilityEstimate);
    const spreadMils = Number(
      leg === 'DOWN' ? snapshot?.spread?.downMils : snapshot?.spread?.upMils
    );
    const depth = Number(
      leg === 'DOWN'
        ? snapshot?.depthFeatures?.downBid
        : snapshot?.depthFeatures?.upBid
    );
    const gap = Number(snapshot?.rawGapBps);
    const timeBucket = sec < 210 ? 'normal' : sec < 260 ? 'late' : 'terminal';
    const volatilityBucket = volBps < 10 ? 'low' : volBps < 30 ? 'medium' : 'high';
    const spreadBucket = spreadMils <= 10 ? 'tight' : 'wide';
    const depthBucket = depth >= 100 ? 'deep' : 'shallow';
    const signalBucket = gap > 1 ? 'up' : gap < -1 ? 'down' : 'neutral';
    return `${executionType}:${timeBucket}:${volatilityBucket}:${spreadBucket}:${depthBucket}:${signalBucket}`;
  }
}
