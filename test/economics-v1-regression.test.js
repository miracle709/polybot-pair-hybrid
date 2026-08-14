import test from 'node:test';
import assert from 'node:assert/strict';
import { LegBook, MarketBook } from '../src/book.js';
import { PARAMS, GUARDS } from '../src/config.js';
import { RoundInventory } from '../src/inventory.js';
import { computeDesiredRungs } from '../src/quoter.js';

function book(bid, ask) {
  return new LegBook(
    [{ price: bid / 1000, size: 500 }],
    [{ price: ask / 1000, size: 500 }],
    1
  );
}

test('V1 characterization: balanced global averages can lock a guaranteed loss', () => {
  const inventory = new RoundInventory('v1-failure-shape', 0);
  inventory.addFill('UP', 478, 100, 100);
  inventory.addFill('DOWN', 589, 100, 110);

  assert.equal(inventory.matchedShares(), 100);
  assert.equal(inventory.tiltShares(), 0);
  assert.equal(inventory.pairCostMils(), 1067);
  assert.equal(inventory.outcomeValue('UP').pnlUsd, -6.7);
  assert.equal(inventory.outcomeValue('DOWN').pnlUsd, -6.7);
});

test('V2 regression: over-cost completed pairs pause further cycle creation', () => {
  const inventory = new RoundInventory('v1-quoter-failure-shape', 0);
  inventory.addFill('UP', 478, 100, 100);
  inventory.addFill('DOWN', 589, 100, 110);

  const result = computeDesiredRungs({
    secondsIntoRound: 120,
    books: new MarketBook(book(480, 490), book(580, 590)),
    inventory,
    params: { ...PARAMS, DYNAMIC_SIZING_ENABLED: false },
    guards: GUARDS,
  });

  assert.equal(result.rungs.length, 0);
  assert.equal(result.pairCycleState, 'PAUSED');
  assert.ok(result.suppressed.some((row) => row.reason === 'pair_hard_max'));
});
