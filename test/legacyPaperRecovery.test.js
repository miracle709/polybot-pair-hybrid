import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverLegacyPaperSnapshots } from '../src/live/legacyPaperRecovery.js';

test('legacy recovery accepts only rich fills from a clean paper shutdown', async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'legacy-paper-')
  );
  const file = path.join(dir, 'events-old.jsonl');
  const rows = [
    {
      type: 'WALLET_FILL',
      rid: 'btc-updown-5m-1000',
      round_slug: 'btc-updown-5m-1000',
      side: 'BUY',
      leg: 'UP',
      p: 400,
      sh: 2.5,
      fee: 0.01,
    },
    {
      type: 'WALLET_FILL',
      rid: 'btc-updown-5m-1000',
      round_slug: 'btc-updown-5m-1000',
      side: 'BUY',
      leg: 'DOWN',
      p: 590,
      sh: 2,
      fee: 0,
    },
    // Target-compatible duplicate has no rid/p/sh and must be ignored.
    {
      type: 'WALLET_FILL',
      round_slug: 'btc-updown-5m-1000',
      side: 'BUY',
      outcome: 'Up',
      price: 0.4,
      shares: 2.5,
    },
    {
      type: 'HEALTH',
      event: 'shutdown',
      mode: 'paper',
      recorder: { dropped: 0 },
    },
  ];
  fs.writeFileSync(
    file,
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
  );

  const recovered = await recoverLegacyPaperSnapshots({
    dir,
    nowEpochSeconds: 2000,
    logger: { info() {} },
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].upShares, 2.5);
  assert.equal(recovered[0].downShares, 2);
  assert.equal(recovered[0].upCostUsd, 1);
  assert.equal(recovered[0].downCostUsd, 1.18);
  assert.equal(recovered[0].feeUsd, 0.01);
  assert.equal(recovered[0].fillCount, 2);
});

test('legacy recovery rejects logs with dropped events or known rounds', async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'legacy-paper-')
  );
  const file = path.join(dir, 'events-old.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: 'WALLET_FILL',
        rid: 'btc-updown-5m-1000',
        side: 'BUY',
        leg: 'UP',
        p: 500,
        sh: 1,
      }),
      JSON.stringify({
        type: 'HEALTH',
        event: 'shutdown',
        mode: 'paper',
        recorder: { dropped: 1 },
      }),
    ].join('\n')
  );
  assert.deepEqual(
    await recoverLegacyPaperSnapshots({
      dir,
      nowEpochSeconds: 2000,
      logger: { info() {} },
    }),
    []
  );

  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: 'WALLET_FILL',
        rid: 'btc-updown-5m-1000',
        side: 'BUY',
        leg: 'UP',
        p: 500,
        sh: 1,
      }),
      JSON.stringify({
        type: 'HEALTH',
        event: 'shutdown',
        mode: 'paper',
        recorder: { dropped: 0 },
      }),
    ].join('\n')
  );
  assert.deepEqual(
    await recoverLegacyPaperSnapshots({
      dir,
      knownRounds: new Set(['btc-updown-5m-1000']),
      nowEpochSeconds: 2000,
      logger: { info() {} },
    }),
    []
  );
});
