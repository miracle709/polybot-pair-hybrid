import test from 'node:test';
import assert from 'node:assert/strict';

import { RoundInventory } from '../src/inventory.js';
import { StrategyIntent } from '../src/strategyIntent.js';

test('intent is preserved on immutable lots and never changes FIFO matching', () => {
  const inventory = new RoundInventory('intent-round', 0);
  const up = inventory.addFill('UP', 480, 5, 1, {
    id: 'up',
    intent: StrategyIntent.DIRECTIONAL,
    signalSnapshotId: 'snap-1',
  });
  inventory.addFill('DOWN', 500, 5, 2, {
    id: 'down',
    intent: StrategyIntent.PAIR_COMPLETE,
  });
  assert.equal(up.intent, StrategyIntent.DIRECTIONAL);
  assert.equal(up.signalSnapshotId, 'snap-1');
  assert.equal(inventory.completedPairs.length, 1);
  assert.equal(inventory.completedPairs[0].pairMils, 980);
  assert.equal(inventory.unmatchedShares('UP'), 0);
  assert.equal(inventory.unmatchedShares('DOWN'), 0);
});
