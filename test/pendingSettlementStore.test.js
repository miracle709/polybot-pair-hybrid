import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PendingSettlementStore,
  settleSnapshot,
  snapshotRunner,
} from '../src/live/pendingSettlementStore.js';
import { RoundInventory } from '../src/inventory.js';
import { RoundRunner } from '../src/roundRunner.js';

const quiet = { warn() {} };

const tempDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'pending-settlement-'));

const sampleSnapshot = (roundSlug = 'btc-updown-5m-1785231600') => ({
  roundSlug,
  windowStartEpoch: 1_785_231_600,
  windowEndEpoch: 1_785_231_900,
  conditionId: '0xabc',
  upIndex: 0,
  upShares: 20,
  downShares: 12,
  upCostUsd: 8,
  downCostUsd: 6.6,
  upAvgMils: 400,
  downAvgMils: 550,
  feeUsd: 0.123456789,
  upFillCount: 1,
  downFillCount: 1,
  fillNotionalUsd: 14.6,
  sweptNotionalUsd: 1.46,
  fillCount: 2,
  firstFillSecond: 12,
  lastFillSecond: 42,
  orderStats: { placed: 3, cancelled: 1, filledShares: 32 },
  protection: { active: false },
  churnRatio: 0.5,
  provenance: { source: 'round_runner' },
});

test('pending settlements survive restart and scope names are sanitized', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = new PendingSettlementStore({
    dir,
    scope: '../../PAPER main',
    logger: quiet,
  });
  first.upsert(sampleSnapshot());
  await first.close();

  assert.equal(
    path.basename(first.filePath),
    'pending-paper-main.json'
  );
  const restored = new PendingSettlementStore({
    dir,
    scope: 'paper main',
    logger: quiet,
  });
  assert.equal(restored.size, 1);
  assert.equal(restored.has(sampleSnapshot().roundSlug), true);
  assert.deepEqual(
    restored.get(sampleSnapshot().roundSlug),
    sampleSnapshot()
  );
  await restored.close();
});

test('paper and live unresolved rounds remain isolated', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const paper = new PendingSettlementStore({ dir, scope: 'paper', logger: quiet });
  const live = new PendingSettlementStore({ dir, scope: 'live', logger: quiet });
  paper.upsert(sampleSnapshot('paper-round'));
  live.upsert(sampleSnapshot('live-round'));
  await Promise.all([paper.close(), live.close()]);

  const paperRestored = new PendingSettlementStore({
    dir,
    scope: 'paper',
    logger: quiet,
  });
  const liveRestored = new PendingSettlementStore({
    dir,
    scope: 'live',
    logger: quiet,
  });
  assert.deepEqual(
    [...paperRestored.entries()].map(([slug]) => slug),
    ['paper-round']
  );
  assert.deepEqual(
    [...liveRestored.entries()].map(([slug]) => slug),
    ['live-round']
  );
  await Promise.all([paperRestored.close(), liveRestored.close()]);
});

test('writes coalesce and close waits for the newest atomic rename', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const writes = [];
  const renames = [];
  let releaseFirst;
  const firstWriteBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let writeCalls = 0;

  const store = new PendingSettlementStore({
    dir,
    scope: 'paper',
    logger: quiet,
    writeFile: async (file, payload) => {
      writes.push({ file, payload });
      writeCalls += 1;
      if (writeCalls === 1) await firstWriteBlocked;
    },
    rename: async (from, to) => {
      renames.push({ from, to });
    },
  });

  store.upsert(sampleSnapshot('round-a'));
  await new Promise((resolve) => setImmediate(resolve));
  store.upsert(sampleSnapshot('round-b'));
  store.remove('round-a');
  const closing = store.close();
  releaseFirst();
  await closing;

  assert.equal(writes.length, 2);
  assert.equal(renames.length, 2);
  assert.equal(writes[0].file, writes[1].file);
  assert.equal(renames[1].to, store.filePath);
  assert.deepEqual(
    JSON.parse(writes.at(-1).payload).map((row) => row.roundSlug),
    ['round-b']
  );
});

test('a transient pending-checkpoint failure is retried and persisted', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let writes = 0;

  const store = new PendingSettlementStore({
    dir,
    scope: 'paper',
    logger: quiet,
    retryMs: 1,
    writeFile: async (file, payload) => {
      writes += 1;
      if (writes === 1) throw new Error('temporary disk error');
      await fs.promises.writeFile(file, payload, 'utf8');
    },
  });
  store.upsert(sampleSnapshot('round-retry'));
  await store.close();

  assert.equal(writes, 2);
  const persisted = JSON.parse(
    fs.readFileSync(store.filePath, 'utf8')
  );
  assert.deepEqual(
    persisted.map((row) => row.roundSlug),
    ['round-retry']
  );
});

test('persistent pending-checkpoint failure is surfaced at shutdown', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let writes = 0;

  const store = new PendingSettlementStore({
    dir,
    scope: 'paper',
    logger: quiet,
    retryMs: 1,
    maxCloseRetries: 2,
    writeFile: async () => {
      writes += 1;
      throw new Error('disk offline');
    },
  });
  store.upsert(sampleSnapshot('round-failed'));
  await assert.rejects(
    () => store.close(),
    /pending settlement checkpoint failed: disk offline/
  );
  assert.equal(writes, 2);
  assert.equal(store.has('round-failed'), true);
});

test('runner snapshot captures complete unresolved economic state', () => {
  const inventory = new RoundInventory(
    'btc-updown-5m-1785231600',
    1_785_231_600
  );
  inventory.addFill('UP', 400, 20, 1_785_231_612);
  inventory.addFill('DOWN', 550, 12, 1_785_231_642);
  const runner = {
    roundSlug: inventory.roundSlug,
    windowStartEpoch: inventory.windowStartEpoch,
    tokenIds: { UP: 'up-token', DOWN: 'down-token' },
    inventory,
    feeUsd: 0.123456789,
    fillNotionalUsd: 14.6,
    sweptNotionalUsd: 1.46,
    firstFillSecond: 12,
    lastFillSecond: 42,
    state: 'SETTLING',
    exchange: { mode: 'paper' },
    params: { ROUND_SECONDS: 300 },
    orders: {
      stats: { placed: 3, cancelled: 1, filledShares: 32 },
      churnRatio: 0.5,
    },
    protection: { active: false },
    priceToBeat: { ptb: 63_500, src: 'chainlink' },
  };
  const snapshot = snapshotRunner(runner, {
    roundSlug: runner.roundSlug,
    conditionId: '0xabc',
    upIndex: 1,
    tokenIds: runner.tokenIds,
    outcomes: ['Down', 'Up'],
  });

  assert.equal(snapshot.windowEndEpoch, 1_785_231_900);
  assert.equal(snapshot.conditionId, '0xabc');
  assert.equal(snapshot.upIndex, 1);
  assert.equal(snapshot.upShares, 20);
  assert.equal(snapshot.downShares, 12);
  assert.equal(snapshot.upCostUsd, 8);
  assert.equal(snapshot.downCostUsd, 6.6);
  assert.equal(snapshot.upAvgMils, 400);
  assert.equal(snapshot.downAvgMils, inventory.avgMils('DOWN'));
  assert.equal(snapshot.provenance.exchangeMode, 'paper');
  assert.equal(snapshot.fillCount, 2);
  assert.equal(snapshot.upFillCount, 1);
  assert.equal(snapshot.downFillCount, 1);
  assert.equal(snapshotRunner({ ...runner, inventory: new RoundInventory('r', 0) }), null);
});

test('interrupted paper accounting hydrates once without losing precision', () => {
  const snapshot = sampleSnapshot();
  const runner = new RoundRunner({
    roundSlug: snapshot.roundSlug,
    windowStartEpoch: snapshot.windowStartEpoch,
    tokenIds: { UP: 'up-token', DOWN: 'down-token' },
    exchange: { mode: 'paper' },
    logger: { info() {}, warn() {}, error() {} },
  });
  runner.restoreAccounting(snapshot);

  assert.equal(runner.inventory.shares('UP'), 20);
  assert.equal(runner.inventory.shares('DOWN'), 12);
  assert.equal(runner.inventory.costUsd('UP'), 8);
  assert.equal(runner.inventory.costUsd('DOWN'), 6.6);
  assert.equal(runner.inventory.legs.UP.fills, 1);
  assert.equal(runner.inventory.legs.DOWN.fills, 1);
  assert.equal(runner.inventory.fillCount(), 2);
  assert.equal(runner.feeUsd, 0.123456789);
  assert.equal(
    Math.round(
      runner.inventory.outcomeValue('UP', runner.feeUsd).pnlUsd * 1e6
    ) / 1e6,
    settleSnapshot(snapshot, 'UP').pnlUsd
  );
  assert.throws(
    () => runner.restoreAccounting(snapshot),
    /cannot restore non-empty/
  );
});

test('V2 restart restores exact FIFO lots and frozen completed-pair economics', () => {
  const inventory = new RoundInventory('btc-updown-5m-1785231600', 1_785_231_600);
  inventory.addFill('UP', 380, 10, 1_785_231_610, { id: 'up-1' });
  inventory.addFill('UP', 420, 5, 1_785_231_611, { id: 'up-2' });
  inventory.addFill('DOWN', 550, 12, 1_785_231_620, { id: 'down-1' });
  const source = {
    roundSlug: inventory.roundSlug,
    windowStartEpoch: inventory.windowStartEpoch,
    tokenIds: { UP: 'u', DOWN: 'd' },
    inventory,
    feeUsd: 0,
    params: { ROUND_SECONDS: 300 },
    orders: { stats: {}, churnRatio: 0 },
    exchange: { mode: 'paper' },
  };
  const snapshot = snapshotRunner(source);
  const runner = new RoundRunner({
    roundSlug: source.roundSlug,
    windowStartEpoch: source.windowStartEpoch,
    tokenIds: source.tokenIds,
    exchange: { mode: 'paper' },
    logger: { info() {}, warn() {}, error() {} },
  });
  runner.restoreAccounting(snapshot);

  assert.deepEqual(
    runner.inventory.completedPairs.map((pair) => [
      pair.upLotId,
      pair.downLotId,
      pair.shares,
      pair.pairMils,
    ]),
    [
      ['up-1', 'down-1', 10, 930],
      ['up-2', 'down-1', 2, 970],
    ]
  );
  assert.equal(Object.isFrozen(runner.inventory.completedPairs[0]), true);
  assert.equal(runner.inventory.unmatchedShares('UP'), 3);
  assert.equal(runner.inventory.unmatchedUpLots[0].id, 'up-2');
  assert.equal(runner.inventory.unmatchedUpLots[0].remainingShares, 3);
});

test('snapshot settlement exactly matches runner arithmetic for either winner', () => {
  const snapshot = sampleSnapshot();
  const downAvgMils = (snapshot.downCostUsd / snapshot.downShares) * 1000;
  const pairCostMils = snapshot.upAvgMils + downAvgMils;

  assert.deepEqual(settleSnapshot(snapshot, 'UP'), {
    roundSlug: snapshot.roundSlug,
    winner: 'UP',
    payoutUsd: 20,
    costUsd: 14.6,
    pnlUsd: 5.276543,
    matchedShares: 12,
    tiltShares: 8,
    pairCostMils,
    pairCostCentsDisplay: pairCostMils / 10,
    fills: 2,
    grossPnlUsd: 5.4,
    feeUsd: 0.123456789,
    upShares: 20,
    downShares: 12,
    upAvgMils: 400,
    downAvgMils,
    sweptNotionalFraction: 0.1,
    firstFillSecond: 12,
    lastFillSecond: 42,
    orderStats: snapshot.orderStats,
    protection: snapshot.protection,
    churnRatio: 0.5,
  });

  const down = settleSnapshot(snapshot, 'DOWN');
  assert.equal(down.payoutUsd, 12);
  assert.equal(down.grossPnlUsd, -2.6);
  assert.equal(down.pnlUsd, -2.723457);
  assert.equal(down.costUsd, 14.6);
  assert.equal(down.feeUsd, 0.123456789);
});
