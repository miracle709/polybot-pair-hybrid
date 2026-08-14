#!/usr/bin/env node
/**
 * Real-data runner.
 *
 *   node scripts/run-live.js          paper fills from the real public book
 *   node scripts/run-live.js --live   real orders (explicitly gated)
 */
import { loadEnv } from './loadEnv.js';
import { buildStrategyConfig, numberEnv } from './strategyConfig.js';
import { Supervisor } from '../src/live/supervisor.js';
import { PolymarketLiveAdapter } from '../src/exchange/polymarketLive.js';
import { PaperExchange } from '../src/exchange/paperExchange.js';
import { RateLimiter } from '../src/live/rateLimiter.js';
import { ResolutionWatcher } from '../src/live/resolution.js';
import { StatusServer } from '../src/live/statusServer.js';
import {
  HttpPriceToBeatProvider,
  FilePriceToBeatProvider,
  ChainlinkPriceToBeatProvider,
  GammaPriceToBeatProvider,
} from '../src/live/priceToBeat.js';

loadEnv();

const mode =
  process.argv.includes('--live') || process.env.LIVE === '1' ? 'live' : 'paper';
const live = mode === 'live';

let client = null;
if (live) {
  const required = [
    'PM_API_KEY',
    'PM_API_SECRET',
    'PM_API_PASSPHRASE',
    'PM_PRIVATE_KEY',
    'FEE_BPS',
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`live mode missing env: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (process.env.CONFIRM_LIVE !== 'YES_I_ACCEPT_REAL_MONEY_RISK') {
    console.error('live mode requires CONFIRM_LIVE=YES_I_ACCEPT_REAL_MONEY_RISK');
    process.exit(1);
  }

  const { createClobClient } = await import('../src/live/clobClient.js');
  ({ client } = createClobClient({
    creds: {
      key: process.env.PM_API_KEY,
      secret: process.env.PM_API_SECRET,
      passphrase: process.env.PM_API_PASSPHRASE,
    },
  }));
}

const { params, guards, sim } = buildStrategyConfig({
  feeMode: live ? 'live' : 'paper',
});

const limiter = new RateLimiter({
  capacity: numberEnv('RL_CAPACITY', 60),
  refillPerSec: numberEnv('RL_REFILL', 8),
});

const adapter =
  mode === 'paper'
    ? new PaperExchange({ ...sim, limiter })
    : new PolymarketLiveAdapter({
        client,
        limiter,
      });
adapter.assertedFeeBps = params.ASSUMED_FEE_BPS_OF_NOTIONAL;

let polygonProvider = null;
if (process.env.POLYGON_RPC) {
  const { ethers } = await import('ethers');
  polygonProvider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
}

let ptbProvider = null;
if (process.env.PTB_FILE) {
  ptbProvider = new FilePriceToBeatProvider({ path: process.env.PTB_FILE });
} else if (process.env.PTB_URL) {
  ptbProvider = new HttpPriceToBeatProvider({ url: process.env.PTB_URL });
} else if (process.env.PTB_FIELD) {
  ptbProvider = new GammaPriceToBeatProvider({ field: process.env.PTB_FIELD });
} else if (polygonProvider) {
  ptbProvider = new ChainlinkPriceToBeatProvider({ provider: polygonProvider });
}

const sup = new Supervisor({
  adapter,
  apiCreds: live
    ? {
        key: process.env.PM_API_KEY,
        secret: process.env.PM_API_SECRET,
        passphrase: process.env.PM_API_PASSPHRASE,
      }
    : null,
  usePrivateFeed: live,
  params,
  guards,
  priceToBeatProvider: ptbProvider,
  resolutionWatcher: new ResolutionWatcher({ ethersProvider: polygonProvider }),
  limits: {
    maxDailyLossUsd: numberEnv('MAX_DAILY_LOSS', 500),
    maxOpenNotionalUsd: numberEnv('MAX_OPEN_NOTIONAL', 2000),
    paperInitialDepositUsd: live
      ? null
      : numberEnv('PAPER_INITIAL_DEPOSIT', 500),
  },
});

await sup.start();
console.log(`mode: ${mode.toUpperCase()}`);

if (process.env.STATUS_PORT !== 'off') {
  new StatusServer({
    supervisor: sup,
    port: Number(process.env.STATUS_PORT ?? 8776),
    host: process.env.STATUS_HOST ?? '127.0.0.1',
    token: process.env.STATUS_TOKEN || null,
    snapshotMs: numberEnv('STATUS_SNAPSHOT_MS', 250),
  }).start();
}

setInterval(() => console.log(JSON.stringify(sup.health())), 300000).unref?.();
