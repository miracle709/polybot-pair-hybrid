import { EventEmitter } from 'node:events';
import { Engine } from '../engine.js';
import { MarketFeed, UserFeed } from './feeds.js';
import { MarketResolver } from './marketResolver.js';
import { ResolutionWatcher } from './resolution.js';
import { SettlementLedger } from './settlementLedger.js';
import { VenueClock, roundTiming } from './venueClock.js';
import {
  PendingSettlementStore,
  settleSnapshot,
  snapshotRunner,
} from './pendingSettlementStore.js';
import { recoverLegacyPaperSnapshots } from './legacyPaperRecovery.js';
import { reconcilePendingSettlements } from './accountReconcile.js';
import { PARAMS, GUARDS } from '../config.js';
import { minimumOrderSharesForParams } from '../orderConstraints.js';
import { roundShares } from '../util.js';
import { cryptoTakerFeeUsd } from '../fees.js';
import {
  maximumComplementPrice,
  takerFeeMilsPerShare,
} from '../pairEconomics.js';
import { tickSizeMils } from '../util.js';
import { ActivityRecorder, NullRecorder } from '../log/recorder.js';
import * as ev from '../log/schema.js';

/**
 * Owns everything that is not the strategy: process lifecycle, feed health,
 * round rollover, the kill switch, and the boot reconciliation.
 *
 * Two of these exist because the target wallet does NOT have them. He runs
 * with no restart path and no kill switch. You should not.
 */
export class Supervisor extends EventEmitter {
  constructor({
    adapter,
    apiCreds,
    params = PARAMS,
    guards = GUARDS,
    logger = console,
    limits = {},
    log = {},
    priceToBeatProvider = null,
    btcReferenceFeed = null,
    settlementReferenceFeed = null,
    probabilityModel = null,
    resolutionWatcher = null,
    usePrivateFeed = false,
    exitOnHalt = null,
  }) {
    super();
    this.adapter = adapter;
    this.mode = adapter.mode ?? 'paper';
    this.exitOnHalt =
      exitOnHalt == null ? this.mode === 'live' : Boolean(exitOnHalt);
    this.settlementPersistenceEnabled = log.enabled !== false;
    this.logDir = log.dir ?? './logs';
    this.recorder =
      log.enabled === false
        ? NullRecorder
        : new ActivityRecorder({
            dir: this.logDir,
            prefix: log.prefix ?? 'activity',
            targetCompatible: true,
            settlementScope: this.mode,
            logger,
          });
    this.usePrivateFeed = usePrivateFeed;
    this.logger = logger;
    this.params = params;
    this.guards = guards;
    this.ptbProvider = priceToBeatProvider;
    this.btcReferenceFeed = btcReferenceFeed;
    this.settlementReferenceFeed = settlementReferenceFeed;
    // Without this nothing ever calls onResolution(), so rounds never settle
    // and PnL is never realised.
    this.resolutionWatcher = resolutionWatcher ?? new ResolutionWatcher({ logger });
    this.resolutionWatcher.on('resolved', ({ roundSlug, winner }) => {
      this.onResolution(roundSlug, winner).catch((err) =>
        this.logger.error?.(`settle failed ${roundSlug}: ${err.message}`)
      );
    });

    this.resolver = new MarketResolver({ logger, roundSeconds: params.ROUND_SECONDS });
    this.marketFeed = new MarketFeed({ logger });
    this.userFeed = new UserFeed({ apiCreds, logger });

    this.engine = new Engine({
      exchange: adapter,
      marketResolver: async (windowStart) => {
        const m = await this.resolver.resolve(windowStart);
        return { roundSlug: m.roundSlug, tokenIds: m.tokenIds };
      },
      logger,
      params,
      guards,
      recorder: this.recorder,
      probabilityModel,
      onInvariantBreach: (info) => {
        const reason =
          info?.reason ??
          `OrderManager invariant breach: ${info?.live} live orders, max ${info?.maxLive}`;
        this.halt(reason).catch((err) =>
          this.logger.error?.(`invariant halt failed: ${err.message}`)
        );
      },
    });
    this.userFeed.setOrderLookup((orderId) => {
      const id = String(orderId);
      if (this.engine.current?.orders?.orderLedger?.has(id)) return true;
      for (const runner of this.engine.pending?.values?.() ?? []) {
        if (runner.orders?.orderLedger?.has(id)) return true;
      }
      return false;
    });

    this.halted = false;
    this.haltReason = null;
    this.fatalExiting = false;
    this.pausedRound = null;
    this.pauseReason = null;
    this.autoBalanceInFlight = false;
    this.shuttingDown = false;
    this.currentWindow = null;
    this.currentMarket = null;
    this.rollInProgress = false;
    this.rollTargetWindow = null;
    this.userFeedHealthy = !usePrivateFeed;
    this.marketClock = new VenueClock();
    this.settlements = new SettlementLedger(
      this.recorder.settledResults?.() ?? []
    );
    this.pendingSettlements = new PendingSettlementStore({
      dir: this.logDir,
      scope: this.mode,
      logger,
    });
    this.pendingCaptureByRound = new Map();
    this.pendingCaptureScheduled = null;
    for (const [roundSlug] of this.pendingSettlements.entries()) {
      if (this.settlements.has(roundSlug)) {
        this.pendingSettlements.remove(roundSlug);
      }
    }
    this.restoredPendingRounds = new Set(
      [...this.pendingSettlements.entries()].map(
        ([roundSlug]) => roundSlug
      )
    );
    this.sessionSettledPnlUsd = 0;
    this.settlingRounds = new Set();
    this.accountingUncertainRounds = new Set();
    this.verifiedPendingRounds = new Set();

    this.limits = {
      maxDailyLossUsd: limits.maxDailyLossUsd ?? 500,
      maxOpenNotionalUsd: limits.maxOpenNotionalUsd ?? 2000,
      maxConsecutiveErrors: limits.maxConsecutiveErrors ?? 20,
    };
    this.paperInitialDepositUsd =
      this.mode === 'paper'
        ? Number.isFinite(Number(limits.paperInitialDepositUsd))
          ? Number(limits.paperInitialDepositUsd)
          : 500
        : null;
    this.dailyPnlUsd = this.settlements.dailyTotal(
      this.marketClock.nowEpochSeconds()
    );
    this.totalPnlUsd = this.settlements.totalPnlUsd;
    this.consecutiveErrors = 0;
    this.healthIntervalMs = limits.healthIntervalMs ?? 30000;
  }

  async start() {
    this.adapter.setFillHandler?.((fill) => this.#onFill(fill));
    this.adapter.setOrderRejectHandler?.((rejection) =>
      this.engine.current?.orders.onReject(rejection)
    );

    // 1. Boot reconciliation. The bot has no memory of orders placed before
    //    a crash. Anything still resting is an unknown position at an
    //    unknown price — pull it all before quoting a single rung.
    const res = await this.adapter.cancelEverything();
    this.logger.info?.(`boot resync: cancelled ${res.cancelled} pre-existing orders`);

    // 2. Fee gate. Throws unless ASSUMED_FEE_BPS_OF_NOTIONAL is set.
    await this.engine.preflight();
    await this.#restorePendingSettlements();
    if (this.halted) {
      this.logger.error?.(
        `supervisor start aborted: ${this.haltReason ?? 'halted'}`
      );
      return;
    }

    // 3. Feeds.
    this.marketFeed.on('book', (books, ts, slug) => this.#onBook(books, ts, slug));
    this.marketFeed.on('stale', () => this.halt('market feed stale'));
    this.marketFeed.on('resync', () => this.#flattenQuotes('book resync'));

    // Directional feeds are deliberately isolated from market-feed health.
    // Missing/stale observations invalidate V3 snapshots but never halt V2.
    this.btcReferenceFeed?.on('price', (observation) =>
      this.engine.onBtcReference(observation)
    );
    this.settlementReferenceFeed?.on('price', (observation) =>
      this.engine.onSettlementReference(observation)
    );

    if (this.usePrivateFeed) {
      this.userFeed.on('connected', () => {
        if (!this.userFeedHealthy) this.logger.info?.('user feed connected');
        this.userFeedHealthy = true;
      });
      this.userFeed.on('fill', (fill) => this.#onFill(fill));
      this.userFeed.on('stale', () => this.halt('user feed stale'));
      this.userFeed.on('disconnected', () => {
        this.userFeedHealthy = false;
        this.#flattenQuotes('user feed disconnected');
      });
      this.userFeed.on('unexpected_sell', (m) =>
        this.#flagAccountingUncertain(
          m,
          `unexpected SELL on this account: ${JSON.stringify(m).slice(0, 200)}`
        )
      );
      this.userFeed.on('ambiguous_fill', (m) =>
        this.#flagAccountingUncertain(
          m,
          `ambiguous private fill attribution; account reconciliation required: ` +
          `${JSON.stringify(m).slice(0, 200)}`
        )
      );
      this.userFeed.on('fill_failed', (m) =>
        this.#flagAccountingUncertain(
          m,
          `private trade became FAILED; account reconciliation required: ` +
          `${JSON.stringify(m).slice(0, 200)}`
        )
      );
    }

    await this.#rollTo(Engine.currentWindowStart());
    this.btcReferenceFeed?.start?.();
    this.settlementReferenceFeed?.start?.();
    this.rollTimer = setInterval(() => this.#maybeRoll(), 1000);
    this.rollTimer.unref?.();

    // Health belongs IN the log. Console-only telemetry cannot be analysed
    // after the fact, and liveOrders / staleBooksDropped / limiter waits are
    // exactly the fields you need to prove a run was healthy.
    this.healthTimer = setInterval(
      () => this.recorder.record(ev.health(this.health())),
      this.healthIntervalMs
    );
    this.healthTimer.unref?.();

    process.once('SIGINT', () => this.shutdown('SIGINT'));
    process.once('SIGTERM', () => this.shutdown('SIGTERM'));
    this.logger.info?.(`supervisor started (${this.mode.toUpperCase()})`);
  }

  async #restorePendingSettlements() {
    if (this.mode === 'paper') {
      const knownRounds = new Set([
        ...this.settlements.history(Number.MAX_SAFE_INTEGER).map(
          (row) => row.roundSlug
        ),
        ...[...this.pendingSettlements.entries()].map(
          ([roundSlug]) => roundSlug
        ),
      ]);
      const recovered = await recoverLegacyPaperSnapshots({
        dir: this.logDir,
        knownRounds,
        excludeFile: this.recorder.filePath ?? null,
        nowEpochSeconds: this.marketClock.nowEpochSeconds(),
        logger: this.logger,
      });
      for (const snapshot of recovered) {
        this.pendingSettlements.upsert(snapshot);
        this.restoredPendingRounds.add(snapshot.roundSlug);
      }
    }

    if (this.mode === 'live') {
      if (this.pendingSettlements.size === 0) return;
      if (typeof this.adapter.getConditionalShares !== 'function') {
        await this.fatalExit(
          'live pending inventory requires adapter.getConditionalShares; ' +
            'refusing to start without venue balance verification'
        );
        return;
      }
      const report = await reconcilePendingSettlements(
        this.pendingSettlements,
        (tokenId) => this.adapter.getConditionalShares(tokenId)
      );
      if (!report.ok) {
        const detail = report.failed
          .map((row) => `${row.roundSlug}:${row.status} (${row.error ?? ''})`)
          .join('; ');
        await this.fatalExit(
          `${report.failed.length} unresolved live round(s) failed account ` +
            `reconciliation: ${detail}. Check wallet conditional balances, ` +
            'redeem CTF out of band if needed, then edit/remove matching ' +
            'entries in logs/pending-live.json before restarting.'
        );
        return;
      }
      const now = this.marketClock.nowEpochSeconds();
      for (const row of report.verified) {
        this.verifiedPendingRounds.add(row.roundSlug);
        this.restoredPendingRounds.add(row.roundSlug);
        const snapshot = row.snapshot;
        if (
          !this.settlements.has(snapshot.roundSlug) &&
          Number(snapshot.windowEndEpoch ?? 0) <= now
        ) {
          this.resolutionWatcher.watch({
            roundSlug: snapshot.roundSlug,
            conditionId: snapshot.conditionId,
            upIndex: snapshot.upIndex,
          });
        }
        this.logger.info?.(
          `[${row.roundSlug}] live pending verified ` +
            `(venue UP=${row.venue?.upShares} DOWN=${row.venue?.downShares})`
        );
      }
      return;
    }

    const now = this.marketClock.nowEpochSeconds();
    for (const [, snapshot] of this.pendingSettlements.entries()) {
      if (
        !this.settlements.has(snapshot.roundSlug) &&
        Number(snapshot.windowEndEpoch ?? 0) <= now
      ) {
        this.resolutionWatcher.watch({
          roundSlug: snapshot.roundSlug,
          conditionId: snapshot.conditionId,
          upIndex: snapshot.upIndex,
        });
      }
    }
  }

  async #maybeRoll() {
    const w = Engine.currentWindowStart(
      this.marketClock.nowEpochSeconds()
    );
    if (w !== this.currentWindow && this.currentMarket) {
      this.#watchForResolution(this.currentMarket);
    }
    if (
      w !== this.currentWindow &&
      w !== this.rollTargetWindow
    ) await this.#rollTo(w);
  }

  #watchForResolution(market) {
    if (!market) return;
    const runner =
      this.engine.current?.roundSlug === market.roundSlug
        ? this.engine.current
        : this.engine.pending?.get?.(market.roundSlug) ?? null;
    if (!this.settlements.has(market.roundSlug)) {
      const snapshot = snapshotRunner(runner, market);
      if (snapshot) {
        const prior = this.pendingSettlements.get(market.roundSlug);
        const changed =
          !prior ||
          prior.upShares !== snapshot.upShares ||
          prior.downShares !== snapshot.downShares ||
          prior.upCostUsd !== snapshot.upCostUsd ||
          prior.downCostUsd !== snapshot.downCostUsd ||
          prior.feeUsd !== snapshot.feeUsd ||
          prior.conditionId !== snapshot.conditionId ||
          prior.upIndex !== snapshot.upIndex;
        if (changed) this.pendingSettlements.upsert(snapshot);
      }
    }
    this.resolutionWatcher.watch({
      roundSlug: market.roundSlug,
      conditionId: market.conditionId,
      upIndex: market.upIndex,
    });
  }

  async #rollTo(windowStart) {
    if (
      windowStart === this.currentWindow ||
      windowStart === this.rollTargetWindow
    ) return;
    this.rollInProgress = true;
    this.rollTargetWindow = windowStart;
    const priorMarket = this.currentMarket;
    try {
      const market = await this.resolver.resolve(windowStart);
      if (Number.isFinite(this.resolver.lastServerEpochSeconds)) {
        this.marketClock.observe(
          this.resolver.lastServerEpochSeconds,
          { trusted: true, source: 'gamma_http' }
        );
      }
      const venueWindow = Engine.currentWindowStart(
        this.marketClock.nowEpochSeconds()
      );
      if (venueWindow !== windowStart) {
        throw new Error(
          `venue clock moved active window to ${venueWindow}; ` +
          `discarding stale activation ${windowStart}`
        );
      }

      // The runner must exist before subscribe(). A snapshot can arrive
      // immediately and may be the only message on a quiet book; dropping it
      // while rollInProgress is true left prices visible but inventory/state
      // permanently blank.
      const runner = await this.engine.rollTo(windowStart, {
        roundSlug: market.roundSlug,
        tokenIds: market.tokenIds,
      });
      if (!runner || runner.roundSlug !== market.roundSlug) {
        throw new Error(`engine did not activate ${market.roundSlug}`);
      }
      if (
        this.restoredPendingRounds.has(market.roundSlug) &&
        (this.mode === 'paper' || this.verifiedPendingRounds.has(market.roundSlug))
      ) {
        const restored = this.pendingSettlements.get(market.roundSlug);
        if (restored) {
          runner.restoreAccounting(restored);
          this.logger.info?.(
            `[${market.roundSlug}] restored interrupted ${this.mode} accounting ` +
            `(${restored.upShares} UP / ${restored.downShares} DOWN shares)`
          );
        }
        this.restoredPendingRounds.delete(market.roundSlug);
        this.verifiedPendingRounds.delete(market.roundSlug);
      }

      // Engine.rollTo has moved the prior runner into pending. Enqueue it
      // before adapter/socket setup so a later subscription failure cannot
      // lose settlement for the completed round.
      if (priorMarket?.roundSlug !== market.roundSlug) {
        this.#watchForResolution(priorMarket);
      }

      // Commit the new market atomically after resolution and runner creation.
      // Dashboard snapshots can now see either the complete old round or the
      // complete new round, never a new countdown attached to old inventory.
      this.adapter.setMarket?.(market);
      this.currentMarket = market;
      this.currentWindow = windowStart;
      this.lastBooks = null;
      this.pausedRound = null;
      this.pauseReason = null;
      this.marketFeed.subscribe(market.tokenIds, market.roundSlug);
      if (this.usePrivateFeed) {
        this.userFeed.setRoundAssets(
          market.tokenIds,
          market.roundSlug
        );
        this.userFeed.subscribe(
          [market.conditionId, priorMarket?.conditionId].filter(Boolean)
        );
      }
      // NOT set true here. It is driven by the socket's `connected` event —
      // asserting it optimistically is what left the bot permanently blind
      // after the first rollover.
      this.resolver.prefetchNext(windowStart);
      this.logger.info?.(`round ${market.roundSlug} subscribed`);

      // The Chainlink strike is logged, not traded on — the target wallet
      // does not read it either. Fired without await so a slow or dead
      // provider can never delay the quoting loop.
      if (this.ptbProvider) {
        this.ptbProvider
          .fetchFor(market.roundSlug, windowStart)
          .then((info) => {
            if (info && this.engine.current?.roundSlug === market.roundSlug) {
              this.engine.current.setPriceToBeat(info);
            }
          })
          .catch((err) => this.logger.debug?.(`ptb fetch failed: ${err.message}`));
      }
    } catch (err) {
      // Gamma includes a trusted HTTP Date even when the requested slug is
      // not available yet. Use it to correct a skewed machine clock, then
      // the next one-second retry targets the venue's actual active window.
      if (Number.isFinite(this.resolver.lastServerEpochSeconds)) {
        this.marketClock.observe(
          this.resolver.lastServerEpochSeconds,
          { trusted: true, source: 'gamma_http' }
        );
      }
      // Retain the complete previous round and retry on the next timer tick.
      // Clearing the market here used to strand the UI and prevented another
      // attempt for the same window.
      this.logger.warn?.(`could not activate window ${windowStart}: ${err.message}`);
    } finally {
      this.rollInProgress = false;
      this.rollTargetWindow = null;
    }
  }

  async #onBook(books, ts, slug) {
    if (!this.currentMarket) return;
    // A book from a round we are no longer on must never reach the engine.
    // Without this guard, books from the new round were quoted against the
    // OLD round's token ids during rollover — in live trading that is real
    // money on the wrong market.
    if (slug && slug !== this.currentMarket.roundSlug) {
      this.staleBooks = (this.staleBooks ?? 0) + 1;
      return;
    }
    // Fresh venue timestamps anchor a monotonic display/strategy clock.
    // Stale initial snapshots are rejected inside VenueClock.
    this.marketClock.observe(ts);
    this.lastBooks = books;
    const arrivalEpoch = this.marketClock.nowEpochSeconds();
    const quotingBlocked =
      this.halted ||
      this.pausedRound === this.currentMarket.roundSlug ||
      (
        this.rollInProgress &&
        this.currentWindow !== this.rollTargetWindow
      );

    // While quoting is paused (auto-balance), only protection FAK orders may
    // match — resting GTC makers must not keep filling after cancel.
    if (this.userFeedHealthy) {
      try {
        this.adapter.onMarketBook?.(
          books,
          arrivalEpoch,
          slug ?? this.currentMarket.roundSlug,
          { protectionOnly: quotingBlocked }
        );
      } catch (err) {
        this.logger.warn?.(`onMarketBook error: ${err.message}`);
      }
    }

    if (quotingBlocked || !this.userFeedHealthy) return;

    try {
      // CLOB snapshot timestamps can be stale (observed 25 minutes behind)
      // and describe the data, not the active round. VenueClock accepts only
      // plausible source values, then advances the accepted anchor
      // monotonically between messages.
      await this.engine.onBook(books, arrivalEpoch, this.currentWindow);
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors += 1;
      this.logger.warn?.(`onBook error (${this.consecutiveErrors}): ${err.message}`);
      if (this.consecutiveErrors >= this.limits.maxConsecutiveErrors) {
        await this.halt(`${this.consecutiveErrors} consecutive errors`);
      }
    }
  }

  #onFill(fill) {
    // Settled / auto-balanced rounds must ignore late venue or paper fills.
    if (fill?.roundSlug && this.settlements.has(fill.roundSlug)) return;
    const runner = this.engine.onFill(fill);
    this.#schedulePendingCapture(runner);
    const inv = runner?.inventory ?? null;
    if (inv && inv.totalNotionalUsd() > this.limits.maxOpenNotionalUsd) {
      const reason =
        `open notional ${inv.totalNotionalUsd()} exceeds ` +
        `${this.limits.maxOpenNotionalUsd} limit`;
      if (this.mode === 'paper') {
        if (
          runner?.roundSlug === this.currentMarket?.roundSlug &&
          this.pausedRound !== runner.roundSlug
        ) {
          this.pausedRound = runner.roundSlug;
          this.pauseReason = reason;
          this.logger.warn?.(`PAPER ROUND PAUSED: ${reason}`);
          this.#flattenQuotes(reason);
        }
      } else {
        this.halt(reason);
      }
    }
    this.emit('fill', fill);
  }

  #schedulePendingCapture(runner) {
    if (!runner?.roundSlug) return;
    if (this.settlements.has(runner.roundSlug)) return;
    this.pendingCaptureByRound.set(runner.roundSlug, runner);
    if (this.pendingCaptureScheduled) return;
    this.pendingCaptureScheduled = setImmediate(() => {
      this.pendingCaptureScheduled = null;
      this.#flushPendingCaptures();
    });
  }

  #flushPendingCaptures() {
    for (const [roundSlug, runner] of this.pendingCaptureByRound) {
      if (this.settlements.has(roundSlug)) continue;
      const market =
        this.currentMarket?.roundSlug === roundSlug
          ? this.currentMarket
          : this.pendingSettlements.get(roundSlug);
      const snapshot = snapshotRunner(runner, market);
      if (snapshot) this.pendingSettlements.upsert(snapshot);
    }
    this.pendingCaptureByRound.clear();
  }

  #flagAccountingUncertain(event, reason) {
    const roundSlug =
      event?.roundSlug ??
      this.currentMarket?.roundSlug ??
      this.engine.current?.roundSlug ??
      null;
    if (roundSlug) this.accountingUncertainRounds.add(roundSlug);
    this.halt(reason).catch((err) =>
      this.logger.error?.(`accounting safety halt failed: ${err.message}`)
    );
  }

  /** Chainlink strike for the current round, from whatever source you have. */
  setPriceToBeat(info) {
    this.engine.current?.setPriceToBeat(info);
  }

  /** Round resolved. Records PnL and checks the daily stop. */
  async onResolution(roundSlug, winner) {
    if (this.accountingUncertainRounds.has(roundSlug)) {
      this.logger.error?.(
        `[${roundSlug}] settlement withheld: private-fill accounting requires reconciliation`
      );
      return null;
    }

    const prior = this.settlements.byRound.get(roundSlug);
    if (prior?.settledBy === 'auto_balance') {
      await this.redeemAutoBalanced(roundSlug, winner, prior);
      const normalizedWinner = String(winner ?? '').toUpperCase();
      const payoutUsd =
        Number.isFinite(Number(prior.payoutUsd)) && Number(prior.payoutUsd) >= 0
          ? Number(prior.payoutUsd)
          : Number.isFinite(Number(prior.matchedShares))
            ? Number(prior.matchedShares)
            : Math.min(
                Number(prior.upShares) || 0,
                Number(prior.downShares) || 0
              );
      const updated = this.settlements.upsert({
        ...prior,
        winner: normalizedWinner,
        resolvedWinner: normalizedWinner,
        payoutUsd,
        settledBy: 'auto_balance',
        // Keep locked PnL / costs / shares; do not re-attribute session totals.
        pnlUsd: prior.pnlUsd,
        ts: prior.ts,
        settledAtEpoch: this.marketClock.nowEpochSeconds(),
      });
      const settlementEvent = ev.roundSettled(roundSlug, {
        ...updated,
        winner: normalizedWinner,
        payoutUsd,
      }, {
        feeUsd: updated?.feeUsd ?? prior.feeUsd,
        shUp: updated?.upShares ?? prior.upShares,
        shDn: updated?.downShares ?? prior.downShares,
      });
      if (this.recorder.recordSettlement) {
        await this.recorder.recordSettlement(settlementEvent);
      } else {
        this.recorder.record(settlementEvent);
      }
      if (this.settlementPersistenceEnabled) {
        this.pendingSettlements.remove(roundSlug);
      }
      this.pendingCaptureByRound.delete(roundSlug);
      this.logger.info?.(
        `[${roundSlug}] auto-balance market winner ${normalizedWinner} ` +
          `(locked pnl $${prior.pnlUsd})`
      );
      return updated ?? prior;
    }

    if (
      this.settlements.has(roundSlug) ||
      this.settlingRounds.has(roundSlug)
    ) return null;
    this.settlingRounds.add(roundSlug);
    try {
      let res = await this.engine.onResolution(roundSlug, winner);
      const pendingSnapshot = this.pendingSettlements.get(roundSlug);
      if (
        !res &&
        pendingSnapshot &&
        (
          this.mode === 'paper' ||
          this.verifiedPendingRounds.has(roundSlug)
        )
      ) {
        res = settleSnapshot(pendingSnapshot, winner);
        const settlementEvent = ev.roundSettled(roundSlug, res, {
          feeUsd: res.feeUsd,
          shUp: res.upShares,
          shDn: res.downShares,
        });
        if (this.recorder.recordSettlement) {
          await this.recorder.recordSettlement(settlementEvent);
        } else {
          this.recorder.record(settlementEvent);
        }
        this.logger.info?.(
          `[${roundSlug}] restored ${this.mode} settlement ${winner} pnl $${res.pnlUsd}`
        );
        this.verifiedPendingRounds.delete(roundSlug);
        this.restoredPendingRounds.delete(roundSlug);
      }
      if (!res) return null;
      const row = this.settlements.upsert({
        ...res,
        ts: this.marketClock.nowEpochSeconds(),
      });
      this.sessionSettledPnlUsd =
        Math.round((this.sessionSettledPnlUsd + res.pnlUsd) * 1e6) / 1e6;
      this.totalPnlUsd = this.settlements.totalPnlUsd;
      this.dailyPnlUsd = this.settlements.dailyTotal(
        this.marketClock.nowEpochSeconds()
      );
      if (this.dailyPnlUsd < -this.limits.maxDailyLossUsd) {
        await this.halt(
          `daily loss ${this.dailyPnlUsd.toFixed(2)} breached stop`
        );
      }
      this.pendingCaptureByRound.delete(roundSlug);
      if (this.settlementPersistenceEnabled) {
        this.pendingSettlements.remove(roundSlug);
      }
      return row ?? res;
    } finally {
      this.settlingRounds.delete(roundSlug);
    }
  }

  /**
   * Attempt CTF redeem for an already HEDGED round without changing locked PnL.
   */
  async redeemAutoBalanced(roundSlug, winner, prior) {
    const runner =
      this.engine.current?.roundSlug === roundSlug
        ? this.engine.current
        : this.engine.pending?.get?.(roundSlug) ?? null;
    const shares =
      runner?.inventory?.shares?.(winner) ??
      (winner === 'UP' ? prior?.upShares : prior?.downShares) ??
      0;
    const tokenId =
      runner?.tokenIds?.[winner] ??
      (this.currentMarket?.roundSlug === roundSlug
        ? this.currentMarket?.tokenIds?.[winner]
        : null);
    if (!(shares > 0) || !tokenId || !this.adapter.redeem) return;
    try {
      await this.adapter.redeem({
        tokenId,
        shares,
        roundSlug,
        winner,
      });
      this.logger.info?.(
        `[${roundSlug}] auto-balance redeem attempted for ${winner} ${shares}sh`
      );
    } catch (err) {
      this.logger.warn?.(
        `[${roundSlug}] auto-balance redeem skipped: ${err.message}`
      );
    }
  }

  /** Pull quotes but stay subscribed and keep counting. Recoverable. */
  async #flattenQuotes(reason) {
    // Closing our own sockets during shutdown fires the same handlers as a
    // real disconnect. Reporting them as incidents after "orders cancelled"
    // makes a clean exit look like a failure.
    if (this.shuttingDown) return;
    this.logger.warn?.(`flattening quotes: ${reason}`);
    try {
      await this.engine.current?.orders.cancelAll();
    } catch (err) {
      this.logger.error?.(`flatten failed: ${err.message}`);
    }
  }

  /**
   * Operator profit-protect: stop quoting, cancel makers, TAKER-FAK hedge
   * until tilt is flat, then lock deterministic settlement PnL once.
   */
  async autoBalance() {
    if (this.autoBalanceInFlight) {
      const err = new Error('auto balance already in progress');
      err.statusCode = 409;
      throw err;
    }
    if (this.halted) {
      const err = new Error(`halted: ${this.haltReason ?? 'unknown'}`);
      err.statusCode = 409;
      throw err;
    }
    const runner = this.engine.current;
    const market = this.currentMarket;
    if (!runner || !market) {
      const err = new Error('no active round');
      err.statusCode = 409;
      throw err;
    }
    if (this.settlements.has(runner.roundSlug)) {
      const row = this.settlements.byRound.get(runner.roundSlug);
      return {
        ok: true,
        lockedPnlUsd: row?.pnlUsd ?? null,
        tiltAfter: 0,
        hedges: [],
        message: 'round already settled',
      };
    }

    this.autoBalanceInFlight = true;
    const reason = 'auto balance';
    const hedges = [];
    const MAX_ATTEMPTS = 3;
    const step = Math.max(
      0.01,
      Number(this.params?.RUNG_SIZE_STEP_SHARES) || 1
    );
    const isPaper = typeof this.adapter.fillFakNow === 'function';
    const flatEps = isPaper ? 0.01 : step;

    try {
      this.pausedRound = market.roundSlug;
      this.pauseReason = reason;
      this.logger.warn?.(`AUTO BALANCE: stopping quotes ${market.roundSlug}`);

      let cancelled = 0;
      try {
        cancelled = runner.orders.live?.size ?? 0;
        // Flush venue/paper open book immediately so cancel-latency GTC makers
        // cannot fill after we lock. Then update the order ledger.
        await this.adapter.cancelEverything?.();
        await runner.orders.cancelAll();
      } catch (err) {
        this.logger.error?.(`auto balance cancel failed: ${err.message}`);
      }

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const tilt = runner.inventory.tiltShares();
        const absTilt = Math.abs(tilt);
        if (absTilt < flatEps) break;

        const size = isPaper
          ? roundShares(absTilt)
          : Math.floor(absTilt / step) * step;
        if (size < (isPaper ? flatEps : step)) break;

        const leg = tilt > 0 ? 'DOWN' : 'UP';
        const aheadLeg = tilt > 0 ? 'UP' : 'DOWN';
        const book = this.lastBooks?.[leg] ?? null;
        if (!book?.bestAsk || !Number.isFinite(book.bestAsk)) {
          return {
            ok: false,
            paused: true,
            pauseReason: reason,
            cancelled,
            hedges,
            tiltAfter: tilt,
            error: `no best ask on ${leg}; quotes stopped but hedge incomplete`,
          };
        }

        const unmatchedLots =
          aheadLeg === 'UP'
            ? runner.inventory.unmatchedUpLots
            : runner.inventory.unmatchedDownLots;
        const feeRate =
          this.params?.POLYMARKET_TAKER_FEE_RATE ??
          PARAMS.POLYMARKET_TAKER_FEE_RATE ??
          0.07;
        const economics = maximumComplementPrice({
          unmatchedLots,
          proposedShares: size,
          pairTargetMils:
            this.params?.PAIR_TARGET_MILS ?? PARAMS.PAIR_TARGET_MILS,
          executionBufferMils:
            this.params?.PAIR_EXECUTION_BUFFER_MILS ??
            PARAMS.PAIR_EXECUTION_BUFFER_MILS,
          expectedFeeMils: (priceMils) =>
            takerFeeMilsPerShare(priceMils, feeRate),
        });
        const rawCapMils = economics.capMils;
        const capTick =
          rawCapMils == null ? 1 : tickSizeMils(Math.max(1, rawCapMils));
        const economicCapMils =
          rawCapMils == null
            ? null
            : Math.floor(rawCapMils / capTick) * capTick;
        const bestAskMils = book.bestAsk;
        const economicDepth = (book.asks ?? [])
          .filter(
            (level) =>
              economicCapMils != null && level.mils <= economicCapMils
          )
          .reduce((total, level) => total + level.size, 0);

        if (
          economicCapMils == null ||
          economicCapMils <= 0 ||
          bestAskMils > economicCapMils ||
          economicDepth <= 0
        ) {
          this.pauseReason = 'hedge_not_economic';
          const result = {
            ok: false,
            code: 'hedge_not_economic',
            paused: true,
            pauseReason: 'hedge_not_economic',
            cancelled,
            hedges,
            leg,
            tiltAfter: tilt,
            bestAskMils,
            economicCapMils,
            requestedShares: size,
            economicDepth,
            lotCaps: economics.lotCaps,
            error:
              `hedge_not_economic: ${leg} best ask ${bestAskMils} ` +
              `exceeds cap ${economicCapMils}`,
          };
          this.recorder.record({
            t: Date.now(),
            type: 'hedge_not_economic',
            round: runner.roundSlug,
            sec: runner.sec,
            ...result,
          });
          return result;
        }

        // FAK may request the full residual while only the displayed depth
        // inside the cap executes; the unfilled remainder is killed. Never
        // widen price to chase size beyond economic depth.
        const economicSize = isPaper
          ? roundShares(size)
          : Math.floor(size / step) * step;
        const minimumOrderShares = minimumOrderSharesForParams(
          economicCapMils,
          this.params ?? PARAMS
        );
        if (economicSize < minimumOrderShares) {
          const minimumOrderNotionalUsd = Math.max(
            PARAMS.MIN_ORDER_NOTIONAL_USD,
            (this.params ?? PARAMS).MIN_ORDER_NOTIONAL_USD ??
              PARAMS.MIN_ORDER_NOTIONAL_USD
          );
          this.pauseReason = 'hedge_below_venue_minimum';
          const result = {
            ok: false,
            code: 'hedge_below_venue_minimum',
            paused: true,
            pauseReason: 'hedge_below_venue_minimum',
            cancelled,
            hedges,
            leg,
            tiltAfter: tilt,
            bestAskMils,
            economicCapMils,
            requestedShares: size,
            economicDepth,
            minimumOrderShares,
            minimumOrderNotionalUsd,
            error:
              `hedge_below_venue_minimum: ${economicSize} shares at ` +
              `$${economicCapMils / 1000} cannot satisfy the $` +
              `${minimumOrderNotionalUsd} order minimum`,
          };
          this.recorder?.record?.({
            t: Date.now(),
            type: 'hedge_below_venue_minimum',
            round: runner.roundSlug,
            sec: runner.sec,
            ...result,
          });
          return result;
        }

        const tokenId = runner.tokenIds?.[leg] ?? market.tokenIds?.[leg];
        let hedge;
        try {
          hedge = await runner.orders.placeProtectionFak({
            leg,
            mils: economicCapMils,
            shares: economicSize,
            tokenId,
          });
        } catch (err) {
          return {
            ok: false,
            paused: true,
            pauseReason: reason,
            cancelled,
            hedges,
            tiltAfter: runner.inventory.tiltShares(),
            error: err.message,
          };
        }

        if (isPaper) {
          const ts =
            this.marketClock.nowEpochSeconds?.() ?? Date.now() / 1000;
          this.adapter.fillFakNow(
            hedge.orderId,
            book,
            ts,
            runner.roundSlug
          );
        } else if (hedge.filledShares > 0.01) {
          const fillPrice = hedge.avgPrice ?? hedge.price;
          const ts =
            this.marketClock.nowEpochSeconds?.() ?? Date.now() / 1000;
          // Book inventory via onFill first, then mark so user-feed skips.
          runner.onFill({
            leg,
            price: fillPrice,
            size: hedge.filledShares,
            fee: cryptoTakerFeeUsd(hedge.filledShares, fillPrice, feeRate),
            ts,
            orderId: hedge.orderId,
            role: 'TAKER',
            full: (hedge.remainingShares ?? 0) <= 0.01,
            status: hedge.status,
          });
          runner.orders.markProtectionFillBooked(hedge.orderId);
        }

        hedges.push({
          ...hedge,
          attempt: attempt + 1,
          tiltBefore: tilt,
          requestedShares: economicSize,
          economicCapMils,
          economicDepth,
          tiltAfter: runner.inventory.tiltShares(),
        });
      }

      const tiltAfter = runner.inventory.tiltShares();
      if (Math.abs(tiltAfter) >= flatEps) {
        return {
          ok: false,
          paused: true,
          pauseReason: reason,
          cancelled,
          hedges,
          tiltAfter,
          error: `hedge incomplete; tilt remains ${tiltAfter}`,
        };
      }

      const lockedWorstCasePnl = runner.inventory.worstCasePnl(
        runner.feeUsd
      );
      if (
        lockedWorstCasePnl < 0 &&
        !(this.params?.ALLOW_NEGATIVE_PAIR_LOCK ??
          PARAMS.ALLOW_NEGATIVE_PAIR_LOCK)
      ) {
        this.pauseReason = 'hedge_not_economic';
        const result = {
          ok: false,
          code: 'hedge_not_economic',
          paused: true,
          pauseReason: 'hedge_not_economic',
          cancelled,
          hedges,
          tiltAfter,
          worstCasePnlUsd: lockedWorstCasePnl,
          error:
            `hedge_not_economic: flat shares would lock ` +
            `$${lockedWorstCasePnl} worst-case PnL`,
        };
        this.recorder.record({
          t: Date.now(),
          type: 'hedge_not_economic',
          round: runner.roundSlug,
          sec: runner.sec,
          ...result,
        });
        return result;
      }

      const closed = await this.closeAutoBalancedRound(runner);
      return {
        ok: true,
        paused: true,
        pauseReason: reason,
        cancelled,
        hedges,
        tiltAfter: 0,
        lockedPnlUsd: closed.pnlUsd,
        settlement: closed,
      };
    } finally {
      this.autoBalanceInFlight = false;
    }
  }

  /**
   * Record locked hedged PnL once. Real Polymarket resolution later no-ops
   * via settlements.has(roundSlug).
   */
  async closeAutoBalancedRound(runner) {
    const roundSlug = runner.roundSlug;
    if (this.settlements.has(roundSlug)) {
      return this.settlements.byRound.get(roundSlug);
    }
    if (this.engine.settledRounds?.has(roundSlug)) {
      return this.settlements.byRound.get(roundSlug) ?? null;
    }

    runner.state = 'SETTLING';
    const res = await runner.closeAsHedged();
    this.engine.settledRounds.add(roundSlug);
    this.engine.history.push(res);
    if (this.engine.pending?.has(roundSlug)) {
      this.engine.pending.delete(roundSlug);
    }

    const row = this.settlements.upsert({
      ...res,
      ts: this.marketClock.nowEpochSeconds(),
    });
    this.sessionSettledPnlUsd =
      Math.round((this.sessionSettledPnlUsd + res.pnlUsd) * 1e6) / 1e6;
    this.totalPnlUsd = this.settlements.totalPnlUsd;
    this.dailyPnlUsd = this.settlements.dailyTotal(
      this.marketClock.nowEpochSeconds()
    );
    this.pendingCaptureByRound.delete(roundSlug);
    if (this.settlementPersistenceEnabled) {
      this.pendingSettlements.remove(roundSlug);
    }
    this.logger.info?.(
      `AUTO BALANCE locked ${roundSlug} pnl $${res.pnlUsd} matched ${res.matchedShares}`
    );
    return row ?? res;
  }

  /**
   * Kill switch. Cancels everything and stops quoting for good. Positions
   * are HELD — the strategy has no sell path and inventing one under stress
   * is how a bad day becomes a bad week. In live mode (exitOnHalt), the
   * process exits after persisting pending inventory so a dashboard cannot
   * look "up" while quoting is permanently blocked.
   */
  async halt(reason) {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
    this.logger.error?.(`HALT: ${reason}`);
    this.recorder.record(ev.halt(reason, this.health()));
    try {
      await this.adapter.cancelEverything();
    } catch (err) {
      this.logger.error?.(`halt cancel failed, CANCEL MANUALLY: ${err.message}`);
    }
    this.emit('halt', reason);
    if (this.exitOnHalt) {
      await this.#exitAfterHalt(reason);
    }
  }

  /**
   * Boot-time hard fail: cancel, persist, print ops context, exit when
   * exitOnHalt is enabled (live default).
   */
  async fatalExit(reason) {
    this.logger.error?.(`FATAL: ${reason}`);
    if (!this.halted) {
      this.halted = true;
      this.haltReason = reason;
      this.recorder.record(ev.halt(reason, this.health()));
      try {
        await this.adapter.cancelEverything();
      } catch (err) {
        this.logger.error?.(
          `fatalExit cancel failed, CANCEL MANUALLY: ${err.message}`
        );
      }
      this.emit('halt', reason);
    }
    if (this.exitOnHalt) {
      await this.#exitAfterHalt(reason);
    }
  }

  async #exitAfterHalt(reason) {
    if (this.fatalExiting) return;
    this.fatalExiting = true;
    try {
      this.#flushPendingCaptures();
      const pendingSnapshot = snapshotRunner(
        this.engine.current,
        this.currentMarket
      );
      if (pendingSnapshot) {
        this.pendingSettlements.upsert(pendingSnapshot);
      }
      try {
        await this.pendingSettlements.close();
      } catch (err) {
        this.logger.error?.(
          `pending settlement flush on halt failed: ${err.message}`
        );
      }
      try {
        await this.recorder.close?.();
      } catch (err) {
        this.logger.error?.(`recorder close on halt failed: ${err.message}`);
      }
    } finally {
      this.logger.error?.(
        `exiting after halt: ${reason}. Redeem CTF out of band if needed; ` +
          'inspect logs/pending-live.json before restarting live.'
      );
      process.exit(1);
    }
  }

  health() {
    const marketNow = this.marketClock.nowEpochSeconds();
    const venueWindow = Engine.currentWindowStart(marketNow);
    const roundActivationPending = venueWindow !== this.currentWindow;
    const rawTiming = roundTiming({
      roundSlug:
        this.engine.current?.roundSlug ??
        this.currentMarket?.roundSlug ??
        null,
      fallbackStart:
        this.engine.current?.windowStartEpoch ??
        this.currentWindow,
      nowEpochSeconds: marketNow,
      roundSeconds: this.params.ROUND_SECONDS,
    });
    const timing = rawTiming
      ? {
          ...rawTiming,
          elapsedSeconds: roundActivationPending
            ? null
            : rawTiming.elapsedSeconds,
          remainingSeconds: roundActivationPending
            ? null
            : rawTiming.remainingSeconds,
          activationPending: roundActivationPending,
          venueWindow,
          expectedRoundSlug: this.resolver.slugFor(venueWindow),
        }
      : {
          activationPending: roundActivationPending,
          venueWindow,
          expectedRoundSlug: this.resolver.slugFor(venueWindow),
        };
    // Never label the completed round's final book as the active market
    // while Gamma/subscription activation is still pending.
    const upBook = roundActivationPending
      ? null
      : this.lastBooks?.UP ?? null;
    const downBook = roundActivationPending
      ? null
      : this.lastBooks?.DOWN ?? null;
    const inventory = this.engine.current?.inventory ?? null;
    const currentFeeUsd = this.engine.current?.feeUsd ?? 0;
    const positionCostUsd = inventory?.totalNotionalUsd() ?? 0;
    const markedValueUsd =
      !inventory || positionCostUsd === 0
        ? 0
        : inventory.markValueUsd(
            upBook?.bestBid,
            downBook?.bestBid
          );
    const markPnlUsd =
      markedValueUsd == null
        ? null
        : markedValueUsd - positionCostUsd - currentFeeUsd;
    const ifUpWins = inventory?.outcomeValue('UP', currentFeeUsd) ?? null;
    const ifDownWins = inventory?.outcomeValue('DOWN', currentFeeUsd) ?? null;
    // Once the current runner is DONE its realized result is already included
    // in totalPnlUsd, so do not add the same round mark a second time.
    const openMarkPnlUsd =
      this.engine.current?.state === 'DONE' ? 0 : markPnlUsd;
    const settledPnlUsdExact = this.settlements.totalPnlUsd;
    const dailyPnlUsdExact = this.settlements.dailyTotal(marketNow);
    const settledPnlUsd = Math.round(settledPnlUsdExact * 100) / 100;
    const dailyPnlUsd = Math.round(dailyPnlUsdExact * 100) / 100;
    const totalMarkedPnlUsd =
      openMarkPnlUsd == null
        ? null
        : Math.round((settledPnlUsdExact + openMarkPnlUsd) * 100) / 100;
    const dailyMarkedPnlUsd =
      openMarkPnlUsd == null
        ? null
        : Math.round((dailyPnlUsdExact + openMarkPnlUsd) * 100) / 100;
    const paperBankrollUsd =
      this.paperInitialDepositUsd == null
        ? null
        : Math.round(
            (this.paperInitialDepositUsd + settledPnlUsdExact) * 100
          ) / 100;
    const paperBankrollMarkedUsd =
      this.paperInitialDepositUsd == null || openMarkPnlUsd == null
        ? null
        : Math.round(
            (this.paperInitialDepositUsd +
              settledPnlUsdExact +
              openMarkPnlUsd) *
              100
          ) / 100;
    return {
      ready: true,
      mode: this.mode,
      halted: this.halted,
      haltReason: this.haltReason,
      paused:
        this.pausedRound === this.currentMarket?.roundSlug ||
        this.engine.current?.state === 'PAUSED',
      pauseReason:
        this.pauseReason ?? this.engine.current?.strategyPauseReason ?? null,
      autoBalanced:
        this.currentMarket?.roundSlug != null &&
        this.settlements.byRound.get(this.currentMarket.roundSlug)
          ?.settledBy === 'auto_balance',
      lockedPnlUsd:
        this.currentMarket?.roundSlug != null
          ? this.settlements.byRound.get(this.currentMarket.roundSlug)
              ?.settledBy === 'auto_balance'
            ? this.settlements.byRound.get(this.currentMarket.roundSlug).pnlUsd
            : null
          : null,
      rollInProgress: this.rollInProgress,
      rollTargetWindow: this.rollTargetWindow,
      roundActivationPending,
      venueWindow,
      window: this.currentWindow,
      round: this.currentMarket?.roundSlug ?? null,
      userFeedHealthy: this.userFeedHealthy,
      staleBooksDropped: this.staleBooks ?? 0,
      market: this.marketFeed.health(),
      engineMode: this.engine.current?.v3Status?.().engineMode ?? 'V2',
      v3: this.engine.current?.v3Status?.() ?? {
        engineMode: 'V2',
        enabled: false,
        shadowOnly: true,
      },
      signalFeeds: {
        btc: this.btcReferenceFeed?.health?.() ?? {
          healthy: false,
          reason: 'not_configured',
        },
        settlementReference:
          this.settlementReferenceFeed?.health?.() ?? {
            healthy: false,
            reason: 'not_configured',
          },
      },
      dailyPnlUsd,
      dailyPnlUsdExact,
      totalPnlUsd: settledPnlUsd,
      settledPnlUsd,
      settledPnlUsdExact,
      sessionSettledPnlUsd:
        Math.round(this.sessionSettledPnlUsd * 100) / 100,
      sessionSettledPnlUsdExact: this.sessionSettledPnlUsd,
      settledRounds: this.settlements.size,
      totalMarkedPnlUsd,
      dailyMarkedPnlUsd,
      paperInitialDepositUsd: this.paperInitialDepositUsd,
      paperBankrollUsd,
      paperBankrollMarkedUsd,
      prices: {
        up: upBook
          ? { bidMils: upBook.bestBid, askMils: upBook.bestAsk, midMils: upBook.midMils }
          : null,
        down: downBook
          ? { bidMils: downBook.bestBid, askMils: downBook.bestAsk, midMils: downBook.midMils }
          : null,
      },
      inventory: inventory?.snapshot() ?? null,
      currentRoundPnl: {
        markedValueUsd:
          markedValueUsd == null
            ? null
            : Math.round(markedValueUsd * 10000) / 10000,
        feeUsd: Math.round(currentFeeUsd * 10000) / 10000,
        markPnlUsd:
          markPnlUsd == null
            ? null
            : Math.round(markPnlUsd * 10000) / 10000,
        mark: 'complete_set_plus_unmatched_best_bid',
        ifUpWins,
        ifDownWins,
        worstCasePnlUsd:
          inventory?.worstCasePnl(currentFeeUsd) ?? 0,
        guaranteedPnlUsd:
          inventory?.guaranteedPnl(currentFeeUsd) ?? 0,
      },
      currentKpis: {
        pairCostMils: inventory?.pairCostMils() ?? null,
        matchedShares: inventory?.matchedShares() ?? 0,
        unmatchedUp: inventory?.unmatchedShares('UP') ?? 0,
        unmatchedDown: inventory?.unmatchedShares('DOWN') ?? 0,
        completedPairCount: inventory?.completedPairs?.length ?? 0,
        completedPairAverageMils:
          inventory?.completedPairAverageMils() ?? null,
        completedPairEdgeUsd:
          inventory?.completedPairEdgeUsd() ?? 0,
        oldestUnmatchedAgeSeconds:
          inventory?.oldestUnmatchedAgeSeconds(marketNow) ?? 0,
        pairCycleState:
          this.engine.current?.currentPairCycleState ?? null,
        pairRegime:
          this.engine.current?.currentPairRegime ?? null,
        complementCapMils:
          this.engine.current?.currentComplementCapMils ?? null,
        pauseNewCycles:
          this.engine.current?.pauseNewCycles ?? false,
        tiltFraction: inventory?.tiltFraction() ?? 0,
        sweptNotionalFraction: this.engine.current?.fillsNotionalUsd
          ? this.engine.current.sweptNotionalUsd /
            this.engine.current.fillsNotionalUsd
          : 0,
      },
      liveOrders: this.engine.current?.orders?.live?.size ?? 0,
      // Compatibility alias plus the exact venue-anchored timing object.
      roundSecond: timing.elapsedSeconds ?? null,
      roundTiming: timing
        ? { ...timing, ...this.marketClock.snapshot() }
        : { ...this.marketClock.snapshot() },
      roundState: this.engine.current?.state ?? null,
      suppressed: this.engine.current?.lastSuppressed ?? [],
      limits: { ...this.limits },
      sizing: {
        dynamic: this.params.DYNAMIC_SIZING_ENABLED,
        depthFraction: this.params.RUNG_DEPTH_FRACTION,
        depthTicks: this.params.DEPTH_SIZING_TICKS,
        minShares: this.params.MIN_RUNG_SHARES,
        minOrderNotionalUsd: this.params.MIN_ORDER_NOTIONAL_USD,
        maxShares: this.params.MAX_RUNG_SHARES,
        maxLegShares: this.params.MAX_LEG_SHARES,
        entryGateSeconds: this.params.ENTRY_GATE_SECONDS,
        openingMaxShares: this.params.OPENING_MAX_RUNG_SHARES,
        openingUntilSeconds: this.params.OPENING_CONSERVATIVE_UNTIL_SECONDS,
        pairTargetMils: this.params.PAIR_TARGET_MILS,
        pairExecutionBufferMils: this.params.PAIR_EXECUTION_BUFFER_MILS,
        pairHardMaxMils: this.params.PAIR_HARD_MAX_MILS,
        maxUnmatchedShares: this.params.MAX_UNMATCHED_SHARES,
        maxUnmatchedAgeSeconds: this.params.MAX_UNMATCHED_AGE_SECONDS,
        replenishAheadLeg: this.params.REPLENISH_AHEAD_LEG,
        roundSoftLimitUsd: this.guards.MAX_ROUND_NOTIONAL_USD.softLimit,
        roundHardLimitUsd: this.guards.MAX_ROUND_NOTIONAL_USD.hardLimit,
        maxTiltShares: this.guards.MAX_TILT_SHARES,
      },
      lastSettled: this.settlements.latest,
      resolutionQueue: this.resolutionWatcher?.queueDepth ?? 0,
      storedUnresolvedRounds: this.pendingSettlements.size,
      accountingUncertainRounds: [...this.accountingUncertainRounds],
      verifiedPendingRounds: [...this.verifiedPendingRounds],
      requiresAccountReconciliation: this.accountingUncertainRounds.size > 0,
      paperSummary: this.adapter.paperSummary ? this.adapter.paperSummary() : null,
      recorder: this.recorder.health(),
    };
  }

  settledHistory(limit = 50) {
    return this.settlements.history(limit);
  }

  async shutdown(reason = 'shutdown') {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.pendingCaptureScheduled) {
      clearImmediate(this.pendingCaptureScheduled);
      this.pendingCaptureScheduled = null;
    }
    this.#flushPendingCaptures();
    const pendingSnapshot = snapshotRunner(
      this.engine.current,
      this.currentMarket
    );
    if (pendingSnapshot) {
      this.pendingSettlements.upsert(pendingSnapshot);
    }
    this.logger.info?.(`shutting down: ${reason}`);
    this.recorder.record(ev.health({ event: 'shutdown', reason, ...this.health() }));
    if (this.rollTimer) clearInterval(this.rollTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.marketFeed.close();
    this.userFeed.close();
    this.btcReferenceFeed?.stop?.();
    this.settlementReferenceFeed?.stop?.();
    this.resolutionWatcher?.stop();
    try {
      await this.adapter.cancelEverything();
    } catch (err) {
      this.logger.error?.(`shutdown cancel failed, CANCEL MANUALLY: ${err.message}`);
    }
    this.logger.info?.('orders cancelled; positions held to resolution');
    // The only place a flush is awaited. Everywhere else logging is
    // fire-and-forget by design.
    try {
      await this.recorder.close();
    } finally {
      // Keep unresolved economic state recoverable even if the diagnostic
      // recorder reports a disk error during shutdown.
      await this.pendingSettlements.close();
    }
  }
}
