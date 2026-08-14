import test from 'node:test';
import assert from 'node:assert/strict';
import { LegBook, MarketBook } from '../src/book.js';
import { PARAMS } from '../src/config.js';
import { RoundInventory } from '../src/inventory.js';
import { computeDesiredRungs, SuppressReason } from '../src/quoter.js';

function failureBooks() {
  return new MarketBook(
    new LegBook(
      [{ price: 0.47, size: 500 }],
      [{ price: 0.48, size: 500 }],
      120
    ),
    new LegBook(
      [{ price: 0.58, size: 500 }],
      [{ price: 0.589, size: 500 }],
      120
    )
  );
}

test('known 478 + 589 failure shape cannot deliberately complete in V2', () => {
  const inventory = new RoundInventory('btc-updown-5m-0', 0);
  inventory.addFill('UP', 478, 10, 100, { id: 'observed-up' });
  const decision = computeDesiredRungs({
    secondsIntoRound: 120,
    books: failureBooks(),
    inventory,
    params: { ...PARAMS, ASSUMED_FEE_BPS_OF_NOTIONAL: 0 },
  });

  assert.equal(decision.rungs.some((rung) => rung.leg === 'UP'), false);
  assert.ok(decision.rungs.every((rung) => rung.mils <= 502));
  assert.equal(decision.complementCapMils, 502);
  assert.ok(
    decision.suppressed.some(
      (row) => row.reason === SuppressReason.AHEAD_LEG
    )
  );
  assert.equal(478 + 589 > PARAMS.PAIR_HARD_MAX_MILS, true);
});

test('profitable replay completion is accepted and then economically frozen', () => {
  const inventory = new RoundInventory('profitable', 0);
  inventory.addFill('UP', 380, 10, 100, { id: 'up' });
  inventory.addFill('DOWN', 550, 6, 110, { id: 'down' });
  const frozen = inventory.completedPairs[0];

  assert.equal(frozen.pairMils, 930);
  assert.equal(frozen.shares, 6);
  assert.equal(inventory.unmatchedShares('UP'), 4);
  inventory.addFill('UP', 700, 2, 120, { id: 'late-expensive' });
  assert.strictEqual(inventory.completedPairs[0], frozen);
  assert.equal(inventory.completedPairs[0].pairMils, 930);
});
