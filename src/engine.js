import { PARAMS, GUARDS, MARKET } from './config.js';
import { RoundRunner } from './roundRunner.js';
import { MarketBook } from './book.js';
import { nowSeconds } from './util.js';

/**
 * Live engine. Owns the round schedule and routes feed events to the
 * runner for the current round.
 *
 * Rounds are contiguous 300-second windows aligned to epoch, so the current
 * window start is always `floor(now / 300) * 300`. He trades essentially
 * every one — 1,473 of a possible 1,489 windows in the capture (98.9%).
 */
export class Engine {
  constructor({
    exchange,
    marketResolver,
    logger = console,
    params = PARAMS,
    guards = GUARDS,
    recorder = null,
    onInvariantBreach = null,
  }) {
    this.exchange = exchange;
    this.recorder = recorder;
    /** async (windowStartEpoch) => {roundSlug, tokenIds:{UP,DOWN}} */
    this.marketResolver = marketResolver;
    this.logger = logger;
    this.params = params;
    this.guards = guards;
    this.onInvariantBreach = onInvariantBreach;
    /** @type {RoundRunner|null} */
    this.current = null;
    this.history = [];
    this.settledRounds = new Set();
    this.settlingRounds = new Set();
    this.started = false;
    /**
     * #rollRound awaits the market resolver. At ~9 book messages/sec two
     * calls entered before `this.current` was assigned, each constructing a
     * RoundRunner — observed as 3 duplicate round_open events across 5
     * rounds. The second runner silently replaced the first.
     */
    this.rollingWindow = null;
  }

  /**
   * Refuses to start until the fee question is answered explicitly.
   *
   * This is not defensive boilerplate. His gross edge is ~1.9% of deployed
   * USDC; a 1.15%-of-volume fee is roughly twice that and turns the whole
   * strategy from +9%/day on capital into a steady bleed. Every one of his
   * 9,032 observed fills carries fee: 0.0, but that is HIS account, not
   * yours, and it cannot be assumed.
   */
  async preflight() {
    const assertedFee = this.params.ASSUMED_FEE_BPS_OF_NOTIONAL;
    if (!Number.isFinite(assertedFee) || assertedFee < 0) {
      throw new Error(
        'preflight: PARAMS.ASSUMED_FEE_BPS_OF_NOTIONAL must be a finite ' +
          'non-negative number. Determine your ' +
          'account\'s actual fee on BTC 5m markets and set it. The strategy is ' +
          'not viable above roughly 40 bps of deployed notional.'
      );
    }
    if (this.exchange.getFeeSchedule) {
      const fees = await this.exchange.getFeeSchedule();
      const worst = Math.max(fees.takerBps ?? 0, fees.makerBps ?? 0);
      if (worst > 40) {
        throw new Error(
          `preflight: venue reports ${worst} bps, which exceeds the strategy's ` +
            'gross edge. Refusing to start.'
        );
      }
      this.logger.info?.(`preflight ok: taker ${fees.takerBps}bps maker ${fees.makerBps}bps`);
    }
    this.started = true;
  }

  static currentWindowStart(nowEpoch = nowSeconds()) {
    return Math.floor(nowEpoch / PARAMS.ROUND_SECONDS) * PARAMS.ROUND_SECONDS;
  }

  /** Call on every book update. `books` must carry both legs. */
  async onBook(books, nowEpoch = nowSeconds(), expectedWindow = null) {
    if (!this.started) throw new Error('engine not started; call preflight() first');
    if (!(books instanceof MarketBook)) throw new TypeError('onBook expects a MarketBook');

    const windowStart =
      expectedWindow ?? Engine.currentWindowStart(nowEpoch);
    if (!this.current || this.current.windowStartEpoch !== windowStart) {
      await this.rollTo(windowStart);
    }
    if (this.current) await this.current.onBook(books, nowEpoch);
  }

  /**
   * Create the round runner before a feed subscription can publish its first
   * snapshot. `market` avoids a duplicate resolver request in Supervisor.
   */
  async rollTo(windowStart, market = null) {
    if (this.current?.windowStartEpoch === windowStart) return this.current;
    if (this.rollingWindow === windowStart) {
      await this.rollPromise;
      return this.current;
    }
    this.rollingWindow = windowStart;
    this.rollPromise = this.#rollRound(windowStart, market).finally(() => {
      if (this.rollingWindow === windowStart) this.rollingWindow = null;
    });
    await this.rollPromise;
    return this.current;
  }

  /** Call on every private fill event. */
  onFill(fill) {
    const runner =
      fill.roundSlug
        ? this.current?.roundSlug === fill.roundSlug
          ? this.current
          : this.pending?.get?.(fill.roundSlug) ?? null
        : this.current;
    if (!runner) return null;
    if (!MARKET.legs.includes(fill.leg)) throw new RangeError(`bad leg ${fill.leg}`);
    runner.onFill(fill);
    return runner;
  }

  /** Call when a round resolves. */
  async onResolution(roundSlug, winner) {
    if (
      this.settledRounds.has(roundSlug) ||
      this.settlingRounds.has(roundSlug)
    ) return null;
    const runner =
      this.current?.roundSlug === roundSlug
        ? this.current
        : this.pending?.get?.(roundSlug) ?? null;
    if (!runner) return null;
    this.settlingRounds.add(roundSlug);
    try {
      const res = await runner.settle(winner);
      this.pending?.delete?.(roundSlug);
      this.settledRounds.add(roundSlug);
      this.history.push(res);
      this.logger.info?.(
        `[${roundSlug}] ${winner} pnl $${res.pnlUsd} pairMils ${res.pairCostMils?.toFixed(1)} ` +
          `matched ${res.matchedShares} tilt ${res.tiltShares} churn ${res.churnRatio.toFixed(1)}:1`
      );
      return res;
    } finally {
      this.settlingRounds.delete(roundSlug);
    }
  }

  async #rollRound(windowStart, resolvedMarket = null) {
    try {
      const { roundSlug, tokenIds } =
        resolvedMarket ?? await this.marketResolver(windowStart);
      // Construct the replacement before mutating current. A resolver or
      // constructor failure must leave the complete previous round active.
      const next = new RoundRunner({
        roundSlug,
        windowStartEpoch: windowStart,
        tokenIds,
        exchange: this.exchange,
        params: this.params,
        guards: this.guards,
        logger: this.logger,
        recorder: this.recorder ?? undefined,
        onInvariantBreach: this.onInvariantBreach,
      });
      if (this.current && this.current.state !== 'DONE') {
        await this.current.orders.cancelAll();
        if (!this.pending) this.pending = new Map();
        this.pending.set(this.current.roundSlug, this.current);
      }
      this.current = next;
      this.logger.info?.(
        `[${roundSlug}] round open, V2 discovery at ` +
          `t=${this.params.PAIR_DISCOVERY_START_SECONDS}s`
      );
    } catch (err) {
      this.logger.error?.(`could not resolve market for ${windowStart}: ${err.message}`);
      throw err;
    }
  }

  async shutdown() {
    if (this.current) await this.current.orders.cancelAll();
    this.logger.info?.('engine shut down; open orders cancelled, positions held to resolution');
  }
}
