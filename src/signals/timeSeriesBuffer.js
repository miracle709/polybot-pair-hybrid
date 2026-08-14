function finite(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RangeError(`${name} must be finite`);
  return number;
}

function timeMs(name, value) {
  const number = finite(name, value);
  if (number < 0) throw new RangeError(`${name} must be non-negative`);
  return number;
}

/**
 * Bounded observation buffer with explicit publication and local arrival
 * times. Queries require both timestamps to be known at decision time.
 */
export class TimeSeriesBuffer {
  constructor({ maxAgeMs = 120_000, maxPoints = 10_000 } = {}) {
    this.maxAgeMs = timeMs('maxAgeMs', maxAgeMs);
    this.maxPoints = Math.max(2, Math.trunc(finite('maxPoints', maxPoints)));
    this.points = [];
  }

  add({
    value,
    publisherTimeMs,
    arrivalTimeMs = publisherTimeMs,
    source = null,
    sourceQuality = null,
    metadata = null,
  }) {
    const point = Object.freeze({
      value: finite('value', value),
      publisherTimeMs: timeMs('publisherTimeMs', publisherTimeMs),
      arrivalTimeMs: timeMs('arrivalTimeMs', arrivalTimeMs),
      source,
      sourceQuality,
      metadata,
    });
    const last = this.points.at(-1);
    if (
      last &&
      last.publisherTimeMs === point.publisherTimeMs &&
      last.source === point.source
    ) {
      // A revised observation with the same publisher timestamp is only
      // visible from its newer arrival time onward.
      this.points[this.points.length - 1] = point;
    } else if (!last || last.publisherTimeMs <= point.publisherTimeMs) {
      this.points.push(point);
    } else {
      let lo = 0;
      let hi = this.points.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.points[mid].publisherTimeMs <= point.publisherTimeMs) lo = mid + 1;
        else hi = mid;
      }
      this.points.splice(lo, 0, point);
    }
    this.#trim(point.arrivalTimeMs);
    return point;
  }

  #trim(nowMs) {
    const cutoff = nowMs - this.maxAgeMs;
    let first = 0;
    while (
      first < this.points.length - 1 &&
      this.points[first].publisherTimeMs < cutoff
    ) first += 1;
    if (first > 0) this.points.splice(0, first);
    if (this.points.length > this.maxPoints) {
      this.points.splice(0, this.points.length - this.maxPoints);
    }
  }

  /** Latest observation published by targetMs and received by decisionTimeMs. */
  latestAtOrBefore(targetMs, decisionTimeMs = targetMs) {
    const target = timeMs('targetMs', targetMs);
    const decision = timeMs('decisionTimeMs', decisionTimeMs);
    for (let i = this.points.length - 1; i >= 0; i -= 1) {
      const point = this.points[i];
      if (
        point.publisherTimeMs <= target &&
        point.publisherTimeMs <= decision &&
        point.arrivalTimeMs <= decision
      ) return point;
    }
    return null;
  }

  causalPoints(decisionTimeMs, fromPublisherTimeMs = -Infinity) {
    const decision = timeMs('decisionTimeMs', decisionTimeMs);
    return this.points.filter(
      (point) =>
        point.publisherTimeMs >= fromPublisherTimeMs &&
        point.publisherTimeMs <= decision &&
        point.arrivalTimeMs <= decision
    );
  }

  fixedHorizonLogReturnBps(decisionTimeMs, horizonMs) {
    const decision = timeMs('decisionTimeMs', decisionTimeMs);
    const horizon = timeMs('horizonMs', horizonMs);
    if (horizon <= 0) throw new RangeError('horizonMs must be positive');
    const current = this.latestAtOrBefore(decision, decision);
    if (!current || current.value <= 0) return null;
    const target = current.publisherTimeMs - horizon;
    if (target < 0) return null;
    const past = this.latestAtOrBefore(target, decision);
    if (!past || past.value <= 0) return null;
    return Object.freeze({
      value: 10_000 * Math.log(current.value / past.value),
      current,
      past,
      horizonMs: horizon,
      targetTimeMs: target,
    });
  }

  /** Causal last-value TWAP. Requires an observation at/before window start. */
  timeWeightedAverage(decisionTimeMs, windowMs) {
    const decision = timeMs('decisionTimeMs', decisionTimeMs);
    const window = timeMs('windowMs', windowMs);
    if (window <= 0) throw new RangeError('windowMs must be positive');
    const start = decision - window;
    if (start < 0) return null;
    const anchor = this.latestAtOrBefore(start, decision);
    if (!anchor) return null;
    const points = this.causalPoints(decision, start).filter(
      (point) => point.publisherTimeMs > start
    );
    let value = anchor.value;
    let cursor = start;
    let integral = 0;
    for (const point of points) {
      integral += value * (point.publisherTimeMs - cursor);
      cursor = point.publisherTimeMs;
      value = point.value;
    }
    integral += value * (decision - cursor);
    return Object.freeze({
      value: integral / window,
      startTimeMs: start,
      endTimeMs: decision,
      anchor,
      sampleCount: points.length + 1,
    });
  }

  /** Realized log volatility expressed per square-root second. */
  realizedVolatility(decisionTimeMs, windowMs) {
    const decision = timeMs('decisionTimeMs', decisionTimeMs);
    const window = timeMs('windowMs', windowMs);
    if (window <= 0) throw new RangeError('windowMs must be positive');
    const start = decision - window;
    if (start < 0) return null;
    const anchor = this.latestAtOrBefore(start, decision);
    if (!anchor || anchor.value <= 0) return null;
    const points = [
      anchor,
      ...this.causalPoints(decision, start).filter(
        (point) => point.publisherTimeMs > start && point.value > 0
      ),
    ];
    if (points.length < 2) return null;
    let sumSquares = 0;
    let elapsedSeconds = 0;
    for (let i = 1; i < points.length; i += 1) {
      const dt = (points[i].publisherTimeMs - points[i - 1].publisherTimeMs) / 1000;
      if (dt <= 0) continue;
      const r = Math.log(points[i].value / points[i - 1].value);
      sumSquares += r * r;
      elapsedSeconds += dt;
    }
    if (elapsedSeconds <= 0) return null;
    return Object.freeze({
      value: Math.sqrt(sumSquares / elapsedSeconds),
      sampleCount: points.length,
      elapsedSeconds,
      startTimeMs: start,
      endTimeMs: decision,
    });
  }

  get size() {
    return this.points.length;
  }
}
