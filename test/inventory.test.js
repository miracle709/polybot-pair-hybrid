import test from 'node:test';
import assert from 'node:assert/strict';
import { RoundInventory } from '../src/inventory.js';

test('outcome values use winning shares minus all fill cost and fees', () => {
  const inventory = new RoundInventory('round-1', 0);
  inventory.addFill('UP', 400, 20, 0);   // $8.00
  inventory.addFill('DOWN', 550, 10, 0); // $5.50

  const up = inventory.outcomeValue('UP', 0.5);
  const down = inventory.outcomeValue('DOWN', 0.5);

  assert.equal(up.investedUsd, 14);
  assert.equal(up.payoutUsd, 20);
  assert.equal(up.pnlUsd, 6);
  assert.equal(up.roi, 6 / 14);

  assert.equal(down.investedUsd, 14);
  assert.equal(down.payoutUsd, 10);
  assert.equal(down.pnlUsd, -4);
  assert.equal(down.roi, -4 / 14);
});

test('settlement uses the same outcome formula before runner fee deduction', () => {
  const inventory = new RoundInventory('round-1', 0);
  inventory.addFill('UP', 490, 20, 0);
  inventory.addFill('DOWN', 480, 20, 0);
  const settled = inventory.settle('UP');
  const projected = inventory.outcomeValue('UP');
  assert.equal(settled.payoutUsd, projected.payoutUsd);
  assert.equal(settled.costUsd, projected.costUsd);
  assert.equal(settled.pnlUsd, projected.pnlUsd);
});

test('fractional fills retain accounting precision until final display', () => {
  const inventory = new RoundInventory('round-precision', 0);
  for (let i = 0; i < 100; i += 1) {
    inventory.addFill('UP', 333, 0.1234, i);
  }
  assert.equal(inventory.shares('UP'), 12.34);
  assert.equal(inventory.costUsd('UP'), 4.10922);
  const outcome = inventory.outcomeValue('UP', 0.01234);
  assert.equal(outcome.investedUsd, 4.12156);
  assert.equal(outcome.pnlUsd, 8.21844);
  assert.equal(
    outcome.pnlUsd,
    outcome.payoutUsd - outcome.costUsd - outcome.feeUsd
  );
});

test('BUY fills create immutable lots with execution identity', () => {
  const inventory = new RoundInventory('lots', 0);
  const lot = inventory.addFill('UP', 380, 10, 100, {
    feeUsd: 0.02,
    orderId: 'order-1',
  });

  assert.equal(Object.isFrozen(lot), true);
  assert.deepEqual(lot, {
    id: 'lots:lot-1',
    leg: 'UP',
    shares: 10,
    priceMils: 380,
    mils: 380,
    remainingShares: 10,
    feeUsd: 0.02,
    ts: 100,
    orderId: 'order-1',
  });
  assert.equal(inventory.unmatchedShares('UP'), 10);
  assert.equal(inventory.unmatchedShares('DOWN'), 0);
});

test('FIFO matching supports partial lots and freezes completed economics', () => {
  const inventory = new RoundInventory('fifo', 0);
  const first = inventory.addFill('UP', 380, 10, 100, { id: 'up-1' });
  inventory.addFill('UP', 400, 5, 101, { id: 'up-2' });
  inventory.addFill('DOWN', 550, 12, 102, { id: 'down-1' });

  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(
    inventory.completedPairs.map((pair) => ({
      upLotId: pair.upLotId,
      downLotId: pair.downLotId,
      shares: pair.shares,
      pairMils: pair.pairMils,
      grossEdgeMils: pair.grossEdgeMils,
    })),
    [
      {
        upLotId: 'up-1',
        downLotId: 'down-1',
        shares: 10,
        pairMils: 930,
        grossEdgeMils: 70,
      },
      {
        upLotId: 'up-2',
        downLotId: 'down-1',
        shares: 2,
        pairMils: 950,
        grossEdgeMils: 50,
      },
    ]
  );
  assert.equal(Object.isFrozen(inventory.completedPairs[0]), true);
  assert.equal(inventory.unmatchedShares('UP'), 3);
  assert.equal(inventory.unmatchedUpLots[0].priceMils, 400);
  assert.equal(inventory.unmatchedUpLots[0].remainingShares, 3);
  assert.equal(inventory.unmatchedShares('DOWN'), 0);
});

test('completed pairs retain their cost when later expensive fills arrive', () => {
  const inventory = new RoundInventory('frozen-pairs', 0);
  inventory.addFill('UP', 380, 6, 100, { id: 'up-good' });
  inventory.addFill('DOWN', 550, 6, 101, { id: 'down-good' });
  const completed = inventory.completedPairs[0];

  inventory.addFill('UP', 700, 4, 102, { id: 'up-late' });

  assert.strictEqual(inventory.completedPairs[0], completed);
  assert.equal(completed.pairMils, 930);
  assert.equal(inventory.completedPairAverageMils(), 930);
  assert.equal(inventory.completedPairEdgeUsd(), 0.42);
  assert.equal(inventory.unmatchedShares('UP'), 4);
});

test('authoritative outcome and worst-case PnL include aggregate fees', () => {
  const inventory = new RoundInventory('pnl', 0);
  inventory.addFill('UP', 400, 20, 100, { feeUsd: 0.1 });
  inventory.addFill('DOWN', 550, 10, 105, { feeUsd: 0.2 });

  assert.equal(inventory.pnlIfUpWins(), 6.2);
  assert.equal(inventory.pnlIfDownWins(), -3.8);
  assert.equal(inventory.worstCasePnl(), -3.8);
  assert.equal(inventory.guaranteedPnl(), -3.8);
  assert.equal(inventory.pnlIfUpWins(0.5), 6);
  assert.equal(inventory.pnlIfDownWins(0.5), -4);
  assert.equal(inventory.oldestUnmatchedAgeSeconds(130), 30);
});
