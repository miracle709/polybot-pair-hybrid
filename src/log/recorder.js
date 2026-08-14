import fs from 'node:fs';
import path from 'node:path';

let atomicWriteSequence = 0;
const atomicWriteFile = async (file, payload) => {
  const temp = `${file}.${process.pid}.${++atomicWriteSequence}.tmp`;
  await fs.promises.writeFile(temp, payload);
  try {
    await fs.promises.rename(temp, file);
  } catch (err) {
    try {
      await fs.promises.unlink(temp);
    } catch {
      // Best-effort cleanup; the original destination remains intact.
    }
    throw err;
  }
};

const targetEvent = (event) => {
  switch (event?.type) {
    case 'ROUND_START':
      return {
        type: 'ROUND_START',
        ts: event.ts,
        round_slug: event.round_slug,
        window_start_epoch: event.window_start_epoch,
        window_end_epoch: event.window_end_epoch,
        token_id_up: event.token_id_up,
        token_id_down: event.token_id_down,
        condition_id: event.condition_id ?? null,
        price_to_beat: event.price_to_beat ?? null,
        raw_market: event.raw_market ?? null,
      };
    case 'PRICE_TO_BEAT_CAPTURED':
      return {
        type: 'PRICE_TO_BEAT_CAPTURED',
        ts: event.ts,
        round_slug: event.round_slug,
        price_to_beat: event.price_to_beat,
        source: event.source,
        window_start_epoch: event.window_start_epoch ?? null,
      };
    case 'TICK': {
      const level = (x) => ({
        price: x.mils / 1000,
        size: x.size,
      });
      return {
        type: 'TICK',
        ts: event.ts,
        round_slug: event.round_slug,
        seconds_into_round: event.seconds_into_round,
        seconds_remaining: event.seconds_remaining,
        price_to_beat: event.price_to_beat,
        price_to_beat_source: event.price_to_beat_source,
        polymarket_btc_usd: event.polymarket_btc_usd,
        binance_btc_usd: event.binance_btc_usd,
        up_token_implied_prob: event.up_token_implied_prob,
        up_book: event._books
          ? {
              bids: event._books.UP.bids.map(level),
              asks: event._books.UP.asks.map(level),
            }
          : null,
        down_book: event._books
          ? {
              bids: event._books.DOWN.bids.map(level),
              asks: event._books.DOWN.asks.map(level),
            }
          : null,
        best_bid_up: event.best_bid_up,
        best_ask_up: event.best_ask_up,
        best_bid_down: event.best_bid_down,
        best_ask_down: event.best_ask_down,
        round_volume_usdc: event.round_volume_usdc ?? 0,
        daily_volume_usdc: event.daily_volume_usdc ?? 0,
        daily_date_et: event.daily_date_et ?? null,
        wallet_pnl_usdc: event.wallet_pnl_usdc ?? null,
        market_winner: event.market_winner ?? null,
        net_shares_up: event.net_shares_up,
        net_shares_down: event.net_shares_down,
        last_round: event.last_round ?? null,
      };
    }
    case 'WALLET_FILL':
      return {
        type: 'WALLET_FILL',
        ts: event.ts,
        round_slug: event.round_slug,
        round_matches_active_round: true,
        seconds_into_round: event.seconds_into_round,
        fill_id: event.oid ?? null,
        outcome: event.outcome,
        side: event.side,
        role: event.role,
        fill_status: event.fill_status,
        transaction_hash: event.transaction_hash ?? null,
        price: event.price,
        shares: event.shares,
        usdc_size: event.usdc_size,
        fee: event.fee,
        matched_side: event.off === 0 ? 'best_bid' : 'other',
        best_bid_at_fill: event.best_bid_at_fill,
        best_ask_at_fill: event.best_ask_at_fill,
        raw: event.raw ?? null,
      };
    case 'ROUND_RESULT':
      return {
        round_slug: event.round_slug,
        winner: event.winner,
        pnl_usdc: event.pnl_usdc,
        volume_usdc: event.volume_usdc,
        net_shares_up: event.net_shares_up,
        net_shares_down: event.net_shares_down,
        ts: event.ts,
        type: 'ROUND_RESULT',
      };
    default:
      return null;
  }
};

/**
 * Activity recorder. JSONL, one event per line.
 *
 * DESIGN CONSTRAINT: `record()` must never slow the quoting loop.
 *
 * How that is achieved:
 *   1. `record()` does exactly one thing — push a plain object into a
 *      pre-allocated ring. No JSON.stringify, no Date formatting, no fs
 *      call, no await. Measured at ~0.1 microseconds per call.
 *   2. Serialization happens in the flusher, on a timer, off the hot path.
 *      Stringifying 500 events costs ~1ms and it costs it in a tick where
 *      no order decision is pending.
 *   3. The ring is BOUNDED. Under a burst the recorder drops the oldest
 *      events and counts them. It will never grow unbounded and it will
 *      never apply backpressure to the strategy. A dropped log line is
 *      free; a 40ms GC pause while a rung sits stale in a moving market
 *      is not.
 *   4. Writes go to a stream with a large highWaterMark and honour `drain`.
 *      If the disk stalls, events queue in the ring and then drop — the
 *      strategy never sees it.
 *
 * The one thing that WOULD block is process exit with a full buffer, so
 * `close()` awaits a final flush. Call it from the shutdown path only.
 */
export class ActivityRecorder {
  /**
   * @param {Object} opts
   * @param {string} opts.dir            output directory
   * @param {string} [opts.prefix]       filename prefix
   * @param {number} [opts.capacity]     ring size in events
   * @param {number} [opts.flushMs]      flush cadence
   * @param {number} [opts.flushAt]      flush early once this many are queued
   * @param {number} [opts.rotateBytes]  roll the file at this size
   * @param {boolean} [opts.enabled]
   * @param {string} [opts.settlementScope] paper/live accounting namespace
   * @param {Function} [opts.sidecarWrite] test seam for asynchronous sidecars
   */
  constructor({
    dir = './logs',
    prefix = 'activity',
    capacity = 65536,
    flushMs = 250,
    flushAt = 2048,
    rotateBytes = 256 * 1024 * 1024,
    maxBatch = 256,
    targetCompatible = false,
    settlementScope = 'default',
    enabled = true,
    logger = console,
    sidecarWrite = atomicWriteFile,
  } = {}) {
    this.dir = dir;
    this.prefix = prefix;
    this.capacity = capacity;
    this.flushMs = flushMs;
    this.flushAt = flushAt;
    this.rotateBytes = rotateBytes;
    // Hard cap on work per flush. Without it, a saturated ring produces one
    // giant stringify — measured at 71ms for 65k events, which is precisely
    // the kind of pause that leaves a rung resting in a moving market.
    // Capping converts that into many sub-millisecond slices.
    this.maxBatch = maxBatch;
    this.enabled = enabled;
    this.targetCompatible = targetCompatible;
    this.settlementScope =
      String(settlementScope || 'default')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'default';
    this.logger = logger;
    this.sidecarWrite = sidecarWrite;

    // Ring buffer. Fixed-size array with head/tail indices — no shift(),
    // no splice(), no reallocation during steady state.
    this.buf = new Array(capacity);
    this.head = 0;
    this.tail = 0;
    this.size = 0;

    this.stream = null;
    this.targetStream = null;
    this.latestStatePath = path.join(this.dir, 'latest_state.json');
    this.roundResultsPath = path.join(this.dir, 'round_results.json');
    this.settlementResultsPath = path.join(
      this.dir,
      `pnl-${this.settlementScope}.json`
    );
    this.roundResults = [];
    this.settlementResults = new Map();
    this.sidecarWrites = new Set();
    // One writer per sidecar. A second TICK arriving while the first
    // latest_state write is still in flight replaces the pending payload
    // instead of starting a competing write. This guarantees monotonic
    // snapshots and also bounds sidecar I/O during a burst.
    this.sidecarStates = new Map();
    this.bytesWritten = 0;
    this.targetBytesWritten = 0;
    this.draining = false;
    this.flushing = false;
    // At most one pending early-flush callback. Without this guard a full
    // ring schedules a setImmediate on EVERY record(), which queues tens of
    // thousands of callbacks and turns a 1ms drain into a 122ms stall.
    this.flushScheduled = false;
    this.closed = false;
    this.timer = null;

    this.stats = { recorded: 0, written: 0, dropped: 0, flushes: 0, maxDepth: 0, writeErrors: 0 };

    if (this.enabled) {
      try {
        const prior = JSON.parse(fs.readFileSync(this.roundResultsPath, 'utf8'));
        if (Array.isArray(prior)) this.roundResults = prior;
      } catch {
        // First run or an incomplete sidecar: the append-only JSONL remains
        // authoritative, so sidecar recovery must never prevent startup.
      }
      try {
        const prior = JSON.parse(
          fs.readFileSync(this.settlementResultsPath, 'utf8')
        );
        if (Array.isArray(prior)) {
          for (const row of prior) {
            const roundSlug = row?.roundSlug ?? row?.round_slug;
            if (roundSlug) this.settlementResults.set(roundSlug, row);
          }
        }
      } catch {
        // First run or an interrupted legacy sidecar. New writes use atomic
        // replacement so the last complete file remains readable.
      }
      this.#open();
    }
  }

  #open() {
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(this.dir, `${this.prefix}-${stamp}.jsonl`);
    this.stream = fs.createWriteStream(this.filePath, {
      flags: 'a',
      highWaterMark: 1 << 20,
    });
    this.stream.on('error', (err) => {
      this.stats.writeErrors += 1;
      this.logger.warn?.(`recorder write error: ${err.message}`);
    });
    this.stream.on('drain', () => {
      this.draining = false;
    });
    if (this.targetCompatible) {
      this.targetFilePath = path.join(this.dir, `events-${stamp}.jsonl`);
      this.targetStream = fs.createWriteStream(this.targetFilePath, {
        flags: 'a',
        highWaterMark: 1 << 20,
      });
      this.targetStream.on('error', () => {
        this.stats.writeErrors += 1;
      });
    }
    this.bytesWritten = 0;
    this.targetBytesWritten = 0;
    this.timer = setInterval(() => this.#flush(), this.flushMs);
    // Unref'd on purpose: logging must never hold the process open. The
    // shutdown path calls close(), which flushes explicitly.
    this.timer.unref?.();
  }

  /**
   * THE HOT PATH. One array write, three integer updates. Nothing else
   * belongs in this method — if you are tempted to add a timestamp format,
   * a stringify, or a filter, add it to the flusher instead.
   *
   * @param {Object} event already-shaped event object (see schema.js)
   */
  record(event) {
    if (!this.enabled || this.closed) return;
    if (this.size === this.capacity) {
      // Overwrite oldest. Dropping is deliberate and counted.
      this.head = (this.head + 1) % this.capacity;
      this.size -= 1;
      this.stats.dropped += 1;
    }
    this.buf[this.tail] = event;
    this.tail = (this.tail + 1) % this.capacity;
    this.size += 1;
    this.stats.recorded += 1;
    if (this.size > this.stats.maxDepth) this.stats.maxDepth = this.size;
    if (this.size >= this.flushAt) this.#scheduleFlush();
  }

  /**
   * Cold-path settlement checkpoint. Unlike ordinary telemetry, cumulative
   * PnL must survive a restart. This is awaited only after a round resolves,
   * never from book/order/fill decision paths.
   */
  async recordSettlement(event) {
    this.record(event);
    if (!this.enabled || this.closed || !event?.round_slug) return;
    while (!this.settlementResults.has(event.round_slug)) {
      if (this.draining) {
        await new Promise((resolve) => this.stream.once('drain', resolve));
      }
      const before = this.size;
      this.#flush();
      if (this.settlementResults.has(event.round_slug)) break;
      // Even on a healthy disk, yield between bounded batches. Settlement
      // for the prior round must not monopolize the event loop while the new
      // round is already receiving books.
      await new Promise((resolve) => setImmediate(resolve));
      if (this.size === before && (!this.stream || this.stream.destroyed)) {
        throw new Error('recorder stream closed before settlement checkpoint');
      }
    }
    // The settlement ledger is the restart source of truth. Retry a
    // transient atomic rename here and surface persistent failure so the
    // supervisor retains its unresolved snapshot instead of claiming the
    // round was durably counted.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = this.sidecarStates.get(this.settlementResultsPath);
      if (!state) {
        throw new Error('settlement checkpoint writer was not created');
      }
      while (state.task || state.pending !== null) {
        if (state.task) await state.task;
        else await new Promise((resolve) => setImmediate(resolve));
      }
      if (!state.error) return;
      if (attempt === 2) {
        throw new Error(
          `settlement checkpoint failed: ${state.error.message}`
        );
      }
      this.#writeSidecar(
        this.settlementResultsPath,
        this.#settlementResultsPayload()
      );
    }
  }

  #scheduleFlush() {
    if (this.flushScheduled || this.flushing) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.#flush();
    });
  }

  #flush() {
    if (!this.enabled || this.flushing || this.draining || this.size === 0) return;
    if (!this.stream || this.stream.destroyed) return;
    this.flushing = true;

    // Drain the ring into a local batch first, so record() can keep
    // accepting events while we serialize.
    const n = Math.min(this.size, this.maxBatch);
    const parts = new Array(n);
    const targetParts = [];
    let latestTick = null;
    const settled = [];
    for (let i = 0; i < n; i += 1) {
      const ev = this.buf[this.head];
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      try {
        parts[i] = JSON.stringify(ev);
        const compatible = targetEvent(ev);
        if (compatible && this.targetCompatible) {
          targetParts.push(JSON.stringify(compatible));
        }
        if (compatible?.type === 'TICK') latestTick = compatible;
        if (compatible?.type === 'ROUND_RESULT') {
          settled.push({ target: compatible, full: ev });
        }
      } catch {
        parts[i] = JSON.stringify({ t: Date.now(), type: 'log_error', note: 'unserialisable' });
      }
    }
    this.size -= n;
    this.flushing = false;

    const payload = `${parts.join('\n')}\n`;
    this.bytesWritten += payload.length;
    this.stats.written += n;
    this.stats.flushes += 1;

    const ok = this.stream.write(payload);
    if (!ok) this.draining = true;
    if (targetParts.length && this.targetStream && !this.targetStream.destroyed) {
      const targetPayload = `${targetParts.join('\n')}\n`;
      this.targetBytesWritten += targetPayload.length;
      this.targetStream.write(targetPayload);
    }

    // Target-tracker compatible sidecars. Both operations are asynchronous
    // and happen after the ring has been drained, never inside record().
    if (latestTick) {
      this.#writeSidecar(
        this.latestStatePath,
        JSON.stringify(latestTick, null, 2)
      );
    }
    if (settled.length) {
      const targetByRound = new Map(
        this.roundResults.map((row) => [row.round_slug, row])
      );
      for (const { target, full } of settled) {
        targetByRound.set(target.round_slug, {
          round_slug: target.round_slug,
          winner: target.winner,
          pnl_usdc: target.pnl_usdc,
          volume_usdc: target.volume_usdc,
          net_shares_up: target.net_shares_up,
          net_shares_down: target.net_shares_down,
          ts: target.ts,
        });
        this.settlementResults.set(target.round_slug, {
          roundSlug: target.round_slug,
          winner: full.outcome ?? target.winner,
          pnlUsd: full.pnl_usd ?? target.pnl_usdc,
          grossPnlUsd:
            full.gross_pnl_usd ??
            full.pnl_usd ??
            target.pnl_usdc,
          costUsd: full.cost_usd ?? target.volume_usdc,
          payoutUsd: full.payout_usd ?? null,
          feeUsd: full.fee_usd ?? 0,
          upShares: full.sh_up ?? target.net_shares_up,
          downShares: full.sh_dn ?? target.net_shares_down,
          upAvgMils: full.up_avg_mils ?? null,
          downAvgMils: full.down_avg_mils ?? null,
          matchedShares: full.matched ?? null,
          tiltShares: full.tilt ?? null,
          pairCostMils: full.pair ?? null,
          firstFillSecond: full.first_sec ?? null,
          lastFillSecond: full.last_sec ?? null,
          orderStats: {
            placed: full.placed ?? null,
            cancelled: full.cancelled ?? null,
          },
          churnRatio: full.churn ?? null,
          ts: full.ts ?? target.ts,
        });
      }
      this.roundResults = [...targetByRound.values()].sort(
        (a, b) =>
          Number(a.ts ?? 0) - Number(b.ts ?? 0) ||
          a.round_slug.localeCompare(b.round_slug)
      );
      this.#writeSidecar(
        this.roundResultsPath,
        JSON.stringify(this.roundResults, null, 2)
      );
      this.#writeSidecar(
        this.settlementResultsPath,
        this.#settlementResultsPayload()
      );
    }

    if (
      this.bytesWritten >= this.rotateBytes ||
      this.targetBytesWritten >= this.rotateBytes
    ) this.#rotate();
    // More waiting? Yield to the event loop first — the quoting loop gets
    // its turn between slices.
    if (this.size > 0 && !this.draining) this.#scheduleFlush();
  }

  #rotate() {
    const old = this.stream;
    const oldTarget = this.targetStream;
    this.logger.info?.(`recorder rotating ${this.filePath} (${this.bytesWritten} bytes)`);
    if (this.timer) clearInterval(this.timer);
    this.#open();
    old.end();
    oldTarget?.end();
  }

  #writeSidecar(file, payload) {
    let state = this.sidecarStates.get(file);
    if (!state) {
      state = { pending: null, task: null, error: null };
      this.sidecarStates.set(file, state);
    }
    // Keep only the newest complete snapshot. round_results payloads are
    // cumulative, so coalescing is safe for that sidecar as well.
    state.pending = payload;
    if (state.task) return;
    this.#startSidecarWriter(file, state);
  }

  #startSidecarWriter(file, state) {
    const task = (async () => {
      while (state.pending !== null) {
        const payload = state.pending;
        state.pending = null;
        try {
          await this.sidecarWrite(file, payload);
          state.error = null;
        } catch (err) {
          state.error = err;
          this.stats.writeErrors += 1;
        }
      }
    })();
    state.task = task;
    this.sidecarWrites.add(task);
    task.finally(() => {
      state.task = null;
      this.sidecarWrites.delete(task);
      // A payload can arrive after the loop observes null but before this
      // completion callback runs. Start another serialized drain if so.
      if (state.pending !== null) this.#startSidecarWriter(file, state);
    });
  }

  #settlementResultsPayload() {
    return JSON.stringify(
      [...this.settlementResults.values()].sort(
        (a, b) =>
          Number(a.ts ?? 0) - Number(b.ts ?? 0) ||
          a.roundSlug.localeCompare(b.roundSlug)
      ),
      null,
      2
    );
  }

  /** Await this only from the shutdown path. */
  async close() {
    if (!this.enabled || this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.flushing = false;
    // Drain every bounded slice before ending the stream. A single #flush()
    // handles only maxBatch events by design; stopping after one slice used
    // to lose the tail of busy rounds, including possible ROUND_RESULT rows.
    while (this.size > 0) {
      if (this.draining) {
        await new Promise((resolve) => this.stream.once('drain', resolve));
      }
      this.#flush();
    }
    await new Promise((resolve) => this.stream.end(resolve));
    if (this.targetStream) {
      await new Promise((resolve) => this.targetStream.end(resolve));
    }
    // A completion callback may enqueue the next coalesced write. Drain
    // until no per-file writer remains rather than awaiting one snapshot of
    // the Set.
    while (this.sidecarWrites.size) {
      await Promise.all([...this.sidecarWrites]);
    }
    this.logger.info?.(
      `recorder closed: ${this.stats.written} written, ${this.stats.dropped} dropped, ` +
        `peak depth ${this.stats.maxDepth}/${this.capacity}`
    );
  }

  health() {
    return {
      file: this.filePath,
      targetFile: this.targetFilePath ?? null,
      schema: 'target-wallet-compatible-v1',
      eventTypes: [
        'ROUND_START',
        'PRICE_TO_BEAT_CAPTURED',
        'TICK',
        'WALLET_FILL',
        'ROUND_RESULT',
      ],
      latestStateFile: this.latestStatePath,
      roundResultsFile: this.roundResultsPath,
      settlementResultsFile: this.settlementResultsPath,
      settlementScope: this.settlementScope,
      settledRounds: this.settlementResults.size,
      depth: this.size,
      capacity: this.capacity,
      ...this.stats,
      // Sustained drops mean the disk cannot keep up. Raise capacity or
      // lower flushMs; do NOT make record() synchronous to compensate.
      dropRate: this.stats.recorded ? this.stats.dropped / this.stats.recorded : 0,
    };
  }

  settledResults() {
    return [...this.settlementResults.values()].map((row) => ({
      ...row,
      orderStats:
        row.orderStats && typeof row.orderStats === 'object'
          ? { ...row.orderStats }
          : row.orderStats,
    }));
  }
}

/** No-op recorder, so call sites never need a null check. */
export const NullRecorder = {
  record() {},
  async recordSettlement() {},
  async close() {},
  health: () => ({ enabled: false }),
  settledResults: () => [],
};
