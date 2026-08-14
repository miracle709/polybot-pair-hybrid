import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcilePendingSnapshot,
  reconcilePendingSettlements,
  RECONCILE_STATUS,
  SHARE_EPSILON,
} from '../src/live/accountReconcile.js';

const sample = (overrides = {}) => ({
  roundSlug: 'btc-updown-5m-100',
  tokenIds: { UP: 'up-tok', DOWN: 'dn-tok' },
  upShares: 20,
  downShares: 12,
  upCostUsd: 8,
  downCostUsd: 6.6,
  ...overrides,
});

test('reconcilePendingSnapshot verifies matching venue shares', async () => {
  const balances = { 'up-tok': 20, 'dn-tok': 12 };
  const row = await reconcilePendingSnapshot(sample(), async (id) => balances[id]);
  assert.equal(row.status, RECONCILE_STATUS.VERIFIED);
  assert.deepEqual(row.venue, { upShares: 20, downShares: 12 });
});

test('reconcilePendingSnapshot allows share epsilon', async () => {
  const balances = { 'up-tok': 20.005, 'dn-tok': 11.995 };
  const row = await reconcilePendingSnapshot(sample(), async (id) => balances[id]);
  assert.equal(row.status, RECONCILE_STATUS.VERIFIED);
  assert.ok(SHARE_EPSILON >= 0.01);
});

test('reconcilePendingSnapshot reports mismatch', async () => {
  const balances = { 'up-tok': 20, 'dn-tok': 0 };
  const row = await reconcilePendingSnapshot(sample(), async (id) => balances[id]);
  assert.equal(row.status, RECONCILE_STATUS.MISMATCH);
  assert.match(row.error, /venue UP=20 DOWN=0/);
});

test('reconcilePendingSnapshot reports missing tokens', async () => {
  const row = await reconcilePendingSnapshot(
    sample({ tokenIds: { UP: 'up-tok' } }),
    async () => 0
  );
  assert.equal(row.status, RECONCILE_STATUS.MISSING_TOKENS);
});

test('reconcilePendingSnapshot reports fetch errors', async () => {
  const row = await reconcilePendingSnapshot(sample(), async () => {
    throw new Error('clob down');
  });
  assert.equal(row.status, RECONCILE_STATUS.FETCH_ERROR);
  assert.match(row.error, /clob down/);
});

test('reconcilePendingSettlements aggregates ok / failed', async () => {
  const pending = [
    sample({ roundSlug: 'ok', upShares: 1, downShares: 1 }),
    sample({
      roundSlug: 'bad',
      upShares: 5,
      downShares: 5,
      tokenIds: { UP: 'u2', DOWN: 'd2' },
    }),
  ];
  const balances = {
    'up-tok': 1,
    'dn-tok': 1,
    u2: 5,
    d2: 0,
  };
  const report = await reconcilePendingSettlements(
    pending,
    async (id) => balances[id]
  );
  assert.equal(report.ok, false);
  assert.equal(report.verified.length, 1);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].roundSlug, 'bad');
});
