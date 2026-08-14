const DEFAULT_ROUND_SECONDS = 300;

const finite = (value) => Number.isFinite(Number(value));

export function windowStartFromMarket(roundSlug, fallback = null) {
  if (typeof roundSlug === 'string') {
    const tail = Number(roundSlug.slice(roundSlug.lastIndexOf('-') + 1));
    if (Number.isInteger(tail) && tail > 0) return tail;
  }
  return finite(fallback) ? Number(fallback) : null;
}

/**
 * Monotonic clock anchored to fresh Polymarket websocket timestamps.
 *
 * Initial CLOB snapshots can carry old timestamps, so an implausibly old
 * source value is ignored. Once a fresh source timestamp is accepted,
 * performance.now() advances it without depending on later Windows wall
 * clock corrections.
 */
export class VenueClock {
  constructor({
    wallNowMs = () => Date.now(),
    monotonicNowMs = () => performance.now(),
    maxSourceSkewMs = 2 * 60 * 1000,
    maxRegressionMs = 2000,
  } = {}) {
    this.wallNowMs = wallNowMs;
    this.monotonicNowMs = monotonicNowMs;
    this.maxSourceSkewMs = maxSourceSkewMs;
    this.maxRegressionMs = maxRegressionMs;
    this.anchor = null;
  }

  observe(
    sourceEpochSeconds,
    { trusted = false, source = 'polymarket_ws' } = {}
  ) {
    const sourceMs = Number(sourceEpochSeconds) * 1000;
    if (!Number.isFinite(sourceMs) || sourceMs <= 0) return false;
    const wallMs = this.wallNowMs();
    if (
      !trusted &&
      Math.abs(sourceMs - wallMs) > this.maxSourceSkewMs
    ) return false;

    const monoMs = this.monotonicNowMs();
    const projectedMs = this.anchor
      ? this.anchor.sourceMs + (monoMs - this.anchor.monotonicMs)
      : null;
    if (
      projectedMs !== null &&
      sourceMs < projectedMs - this.maxRegressionMs
    ) return false;

    this.anchor = {
      // Do not move time backward for a slightly out-of-order token update.
      sourceMs: projectedMs === null ? sourceMs : Math.max(sourceMs, projectedMs),
      monotonicMs: monoMs,
      observedWallMs: wallMs,
      offsetMs: sourceMs - wallMs,
      source,
    };
    return true;
  }

  nowEpochSeconds() {
    if (!this.anchor) return this.wallNowMs() / 1000;
    return (
      this.anchor.sourceMs +
      (this.monotonicNowMs() - this.anchor.monotonicMs)
    ) / 1000;
  }

  snapshot() {
    return {
      source: this.anchor?.source ?? 'system_fallback',
      offsetMs: this.anchor?.offsetMs ?? null,
      anchorAgeMs: this.anchor
        ? Math.max(0, this.monotonicNowMs() - this.anchor.monotonicMs)
        : null,
    };
  }
}

export function roundTiming({
  roundSlug,
  fallbackStart = null,
  nowEpochSeconds,
  roundSeconds = DEFAULT_ROUND_SECONDS,
}) {
  const startEpoch = windowStartFromMarket(roundSlug, fallbackStart);
  const nowEpoch = Number(nowEpochSeconds);
  if (
    startEpoch === null ||
    !Number.isFinite(nowEpoch) ||
    !Number.isFinite(roundSeconds) ||
    roundSeconds <= 0
  ) return null;

  const endEpoch = startEpoch + roundSeconds;
  const elapsedSeconds = Math.max(
    0,
    Math.min(roundSeconds, nowEpoch - startEpoch)
  );
  const remainingSeconds = Math.max(
    0,
    Math.min(roundSeconds, endEpoch - nowEpoch)
  );
  return {
    startEpoch,
    endEpoch,
    nowEpoch,
    elapsedSeconds,
    remainingSeconds,
    durationSeconds: roundSeconds,
  };
}
