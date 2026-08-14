import fs from 'node:fs';
import path from 'node:path';
import { roundAccounting, windowStartFromSlug } from '../util.js';

const STORE_VERSION = 2;

const safeScope = (scope) => {
  const safe = String(scope ?? 'paper')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return safe || 'paper';
};

const finiteOr = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const plainClone = (value) => {
  if (Array.isArray(value)) return value.map(plainClone);
  if (!value || typeof value !== 'object') {
    return Number.isFinite(value) || typeof value !== 'number' ? value : null;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== 'function' && child !== undefined) {
      out[key] = plainClone(child);
    }
  }
  return out;
};

const copySnapshot = (snapshot) => {
  const out = { ...snapshot };
  if ('tokenIds' in snapshot) {
    out.tokenIds = snapshot.tokenIds ? { ...snapshot.tokenIds } : null;
  }
  if ('orderStats' in snapshot) {
    out.orderStats = snapshot.orderStats ? { ...snapshot.orderStats } : {};
  }
  if ('protection' in snapshot) {
    out.protection = snapshot.protection
      ? plainClone(snapshot.protection)
      : {};
  }
  if ('provenance' in snapshot) {
    out.provenance = snapshot.provenance
      ? plainClone(snapshot.provenance)
      : {};
  }
  if ('inventoryAccounting' in snapshot) {
    out.inventoryAccounting = snapshot.inventoryAccounting
      ? plainClone(snapshot.inventoryAccounting)
      : null;
  }
  return out;
};

const parseWindowStart = (runner) => {
  const direct = finiteOr(runner?.windowStartEpoch);
  if (direct !== null) return direct;
  try {
    return windowStartFromSlug(runner?.roundSlug ?? '');
  } catch {
    return null;
  }
};

/**
 * Capture the minimum complete economic state required to settle a runner
 * after a process restart. This is a cold-path operation: callers should
 * invoke it after a fill or rollover, never from every book update.
 */
export function snapshotRunner(runner, market = null) {
  const inventory = runner?.inventory;
  if (!runner?.roundSlug || !inventory) return null;

  const upShares = roundAccounting(finiteOr(inventory.shares?.('UP'), 0));
  const downShares = roundAccounting(
    finiteOr(inventory.shares?.('DOWN'), 0)
  );
  if (!(upShares > 0) && !(downShares > 0)) return null;

  const upCostUsd = roundAccounting(finiteOr(inventory.costUsd?.('UP'), 0));
  const downCostUsd = roundAccounting(
    finiteOr(inventory.costUsd?.('DOWN'), 0)
  );
  const windowStartEpoch = parseWindowStart(runner);
  const roundSeconds = finiteOr(runner.params?.ROUND_SECONDS, 300);
  const tokenIds = market?.tokenIds ?? runner.tokenIds ?? null;
  const fillCount =
    typeof inventory.fillCount === 'function'
      ? inventory.fillCount()
      : Array.isArray(inventory.fills)
        ? inventory.fills.length
        : finiteOr(inventory.legs?.UP?.fills, 0) +
          finiteOr(inventory.legs?.DOWN?.fills, 0);

  return {
    version: STORE_VERSION,
    roundSlug: runner.roundSlug,
    windowStartEpoch,
    windowEndEpoch:
      windowStartEpoch === null
        ? null
        : windowStartEpoch + roundSeconds,
    conditionId: market?.conditionId ?? runner.conditionId ?? null,
    upIndex: finiteOr(market?.upIndex ?? runner.upIndex, null),
    tokenIds: tokenIds
      ? {
          UP: tokenIds.UP == null ? null : String(tokenIds.UP),
          DOWN: tokenIds.DOWN == null ? null : String(tokenIds.DOWN),
        }
      : null,
    upShares,
    downShares,
    upCostUsd,
    downCostUsd,
    upAvgMils:
      upShares > 0
        ? (upCostUsd / upShares) * 1000
        : null,
    downAvgMils:
      downShares > 0
        ? (downCostUsd / downShares) * 1000
        : null,
    feeUsd: roundAccounting(finiteOr(runner.feeUsd, 0)),
    upFillCount: finiteOr(inventory.legs?.UP?.fills, 0),
    downFillCount: finiteOr(inventory.legs?.DOWN?.fills, 0),
    fillNotionalUsd: roundAccounting(
      finiteOr(runner.fillNotionalUsd, upCostUsd + downCostUsd)
    ),
    sweptNotionalUsd: roundAccounting(
      finiteOr(runner.sweptNotionalUsd, 0)
    ),
    fillCount,
    inventoryAccounting:
      typeof inventory.accountingSnapshot === 'function'
        ? plainClone(inventory.accountingSnapshot())
        : null,
    firstFillSecond: finiteOr(runner.firstFillSecond, null),
    lastFillSecond: finiteOr(runner.lastFillSecond, null),
    orderStats: plainClone(runner.orders?.stats ?? {}),
    protection: plainClone(runner.protection ?? {}),
    churnRatio: finiteOr(runner.orders?.churnRatio, null),
    provenance: {
      source: 'round_runner',
      capturedAtEpoch: Date.now() / 1000,
      runnerState: runner.state ?? null,
      exchangeMode: runner.exchange?.mode ?? null,
      marketRoundSlug: market?.roundSlug ?? null,
      outcomes: plainClone(market?.outcomes ?? null),
      priceToBeat: plainClone(runner.priceToBeat ?? null),
    },
  };
}

/**
 * Settle a persisted runner snapshot with the same arithmetic and result
 * shape as RoundRunner.settle(). No venue calls are made here.
 */
export function settleSnapshot(snapshot, winner) {
  const normalizedWinner = String(winner ?? '').toUpperCase();
  if (normalizedWinner !== 'UP' && normalizedWinner !== 'DOWN') {
    throw new RangeError(`settleSnapshot: unknown winner ${winner}`);
  }
  if (!snapshot?.roundSlug) {
    throw new TypeError('settleSnapshot: snapshot.roundSlug is required');
  }

  const upShares = roundAccounting(finiteOr(snapshot.upShares, 0));
  const downShares = roundAccounting(finiteOr(snapshot.downShares, 0));
  const upCostUsd = roundAccounting(finiteOr(snapshot.upCostUsd, 0));
  const downCostUsd = roundAccounting(finiteOr(snapshot.downCostUsd, 0));
  const feeUsd = roundAccounting(finiteOr(snapshot.feeUsd, 0));
  const costUsd = roundAccounting(upCostUsd + downCostUsd);
  const payoutUsd = roundAccounting(
    normalizedWinner === 'UP' ? upShares : downShares
  );
  const grossPnlUsd = roundAccounting(payoutUsd - costUsd);
  const pnlUsd =
    Math.round((grossPnlUsd - feeUsd) * 1e6) / 1e6;
  const upAvgMils =
    upShares > 0 ? (upCostUsd / upShares) * 1000 : null;
  const downAvgMils =
    downShares > 0 ? (downCostUsd / downShares) * 1000 : null;
  const pairCostMils =
    upAvgMils === null || downAvgMils === null
      ? null
      : upAvgMils + downAvgMils;
  const fillNotionalUsd = finiteOr(snapshot.fillNotionalUsd, 0);

  return {
    roundSlug: snapshot.roundSlug,
    winner: normalizedWinner,
    payoutUsd,
    costUsd,
    pnlUsd,
    matchedShares: Math.min(upShares, downShares),
    tiltShares: roundAccounting(upShares - downShares),
    pairCostMils,
    pairCostCentsDisplay:
      pairCostMils === null ? null : pairCostMils / 10,
    fills: finiteOr(snapshot.fillCount, 0),
    grossPnlUsd,
    feeUsd,
    upShares,
    downShares,
    upAvgMils,
    downAvgMils,
    sweptNotionalFraction:
      fillNotionalUsd
        ? finiteOr(snapshot.sweptNotionalUsd, 0) / fillNotionalUsd
        : 0,
    firstFillSecond: finiteOr(snapshot.firstFillSecond, null),
    lastFillSecond: finiteOr(snapshot.lastFillSecond, null),
    orderStats: { ...(snapshot.orderStats ?? {}) },
    protection: plainClone(snapshot.protection ?? {}),
    churnRatio: finiteOr(snapshot.churnRatio, null),
  };
}

/**
 * Mode-scoped unresolved-round persistence. Mutations only touch memory and
 * schedule an asynchronous writer; serialization and filesystem I/O never
 * run in the caller's stack.
 */
export class PendingSettlementStore {
  constructor({
    dir = './logs',
    scope = 'paper',
    logger = console,
    writeFile = (file, payload) =>
      fs.promises.writeFile(file, payload, 'utf8'),
    rename = (from, to) => fs.promises.rename(from, to),
    retryMs = 1000,
    maxCloseRetries = 3,
  } = {}) {
    this.dir = dir;
    this.scope = safeScope(scope);
    this.logger = logger;
    this.writeFile = writeFile;
    this.rename = rename;
    this.retryMs = Math.max(1, Number(retryMs) || 1000);
    this.maxCloseRetries = Math.max(
      1,
      Math.floor(Number(maxCloseRetries) || 3)
    );
    this.filePath = path.join(this.dir, `pending-${this.scope}.json`);
    this.tempPath = path.join(
      this.dir,
      `.pending-${this.scope}.${process.pid}.tmp`
    );
    this.byRound = new Map();
    this.dirty = false;
    this.scheduled = null;
    this.writer = null;
    this.closed = false;
    this.lastError = null;
    this.closeFailures = 0;

    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const rows = Array.isArray(parsed) ? parsed : parsed?.pending;
      if (!Array.isArray(rows)) {
        throw new TypeError('pending settlement file must contain an array');
      }
      for (const row of rows) {
        if (row?.roundSlug) {
          this.byRound.set(String(row.roundSlug), copySnapshot(row));
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.logger.warn?.(
          `pending settlement load failed ${this.filePath}: ${err.message}`
        );
      }
    }
  }

  upsert(snapshot) {
    if (this.closed) return null;
    if (!snapshot?.roundSlug) {
      throw new TypeError('pending settlement snapshot requires roundSlug');
    }
    const row = copySnapshot({
      ...snapshot,
      roundSlug: String(snapshot.roundSlug),
    });
    this.byRound.set(row.roundSlug, row);
    this.#scheduleWrite();
    return copySnapshot(row);
  }

  remove(roundSlug) {
    if (this.closed) return false;
    const removed = this.byRound.delete(String(roundSlug));
    if (removed) this.#scheduleWrite();
    return removed;
  }

  get(roundSlug) {
    const row = this.byRound.get(String(roundSlug));
    return row ? copySnapshot(row) : null;
  }

  has(roundSlug) {
    return this.byRound.has(String(roundSlug));
  }

  *entries() {
    for (const [roundSlug, row] of this.byRound) {
      yield [roundSlug, copySnapshot(row)];
    }
  }

  get size() {
    return this.byRound.size;
  }

  #scheduleWrite() {
    this.dirty = true;
    if (this.writer || this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      this.#startWriter();
    });
    this.scheduled.unref?.();
  }

  #startWriter() {
    if (this.writer || !this.dirty) return;
    const task = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const payload = JSON.stringify(
          [...this.byRound.values()],
          null,
          2
        );
        try {
          await this.writeFile(this.tempPath, payload);
          await this.rename(this.tempPath, this.filePath);
          this.lastError = null;
          this.closeFailures = 0;
        } catch (err) {
          this.lastError = err;
          this.dirty = true;
          if (this.closed) this.closeFailures += 1;
          this.logger.warn?.(
            `pending settlement write failed ${this.filePath}: ${err.message}`
          );
          if (
            this.closed &&
            this.closeFailures >= this.maxCloseRetries
          ) {
            // close() reports the failure to its caller. Stop the internal
            // retry loop so shutdown cannot hang forever on a dead disk.
            this.dirty = false;
            break;
          }
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              this.closed ? Math.min(this.retryMs, 25) : this.retryMs
            )
          );
        }
      }
    })();
    this.writer = task;
    task.finally(() => {
      if (this.writer === task) this.writer = null;
      if (this.dirty) {
        if (this.closed) this.#startWriter();
        else this.#scheduleWrite();
      }
    });
  }

  async close() {
    if (this.closed && !this.writer && !this.dirty) {
      if (this.lastError) {
        throw new Error(
          `pending settlement checkpoint failed: ${this.lastError.message}`
        );
      }
      return;
    }
    this.closed = true;
    this.closeFailures = 0;
    if (this.scheduled) {
      clearImmediate(this.scheduled);
      this.scheduled = null;
    }
    if (this.dirty && !this.writer) this.#startWriter();
    while (this.writer || this.dirty) {
      if (!this.writer) this.#startWriter();
      if (this.writer) await this.writer;
    }
    if (this.lastError) {
      throw new Error(
        `pending settlement checkpoint failed: ${this.lastError.message}`
      );
    }
  }
}
