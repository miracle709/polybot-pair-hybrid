import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAMS, GUARDS } from '../src/config.js';
import {
  booleanEnv,
  numberEnv,
  buildStrategyConfig,
} from '../scripts/strategyConfig.js';

const saved = { ...process.env };

function resetEnv(overrides = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved, overrides);
}

test('numberEnv treats empty string as missing', () => {
  process.env.MAX_RUNG_SHARES = '';
  assert.equal(numberEnv('MAX_RUNG_SHARES', PARAMS.MAX_RUNG_SHARES), PARAMS.MAX_RUNG_SHARES);
  process.env.MAX_RUNG_SHARES = saved.MAX_RUNG_SHARES;
});

test('booleanEnv accepts explicit overlays and rejects ambiguous values', () => {
  resetEnv({ REPLENISH_AHEAD_LEG: '1' });
  assert.equal(booleanEnv('REPLENISH_AHEAD_LEG', false), true);
  resetEnv({ REPLENISH_AHEAD_LEG: 'false' });
  assert.equal(booleanEnv('REPLENISH_AHEAD_LEG', true), false);
  resetEnv({ REPLENISH_AHEAD_LEG: 'yes' });
  assert.throws(() => booleanEnv('REPLENISH_AHEAD_LEG', false), /0, 1/);
  resetEnv();
});

test('V2 pair-cycle configuration uses canonical environment overlays', () => {
  resetEnv({
    PAIR_TARGET_MILS: '980',
    PAIR_EXECUTION_BUFFER_MILS: '7',
    PAIR_HARD_MAX_MILS: '994',
    MAX_UNMATCHED_SHARES: '8',
    MAX_UNMATCHED_AGE_SECONDS: '45',
    ALLOW_NEGATIVE_PAIR_LOCK: 'true',
    PAIR_DISCOVERY_START_SECONDS: '21',
    PAIR_ACCUMULATION_START_SECONDS: '91',
    PAIR_ACCUMULATION_END_SECONDS: '211',
    PAIR_COMPLETION_END_SECONDS: '261',
    PAIR_RISK_REDUCTION_END_SECONDS: '286',
    REPLENISH_AHEAD_LEG: '1',
  });
  const { params } = buildStrategyConfig({ feeMode: 'paper' });

  assert.equal(params.PAIR_TARGET_MILS, 980);
  assert.equal(params.PAIR_EXECUTION_BUFFER_MILS, 7);
  assert.equal(params.PAIR_HARD_MAX_MILS, 994);
  assert.equal(params.MAX_UNMATCHED_SHARES, 8);
  assert.equal(params.MAX_UNMATCHED_AGE_SECONDS, 45);
  assert.equal(params.ALLOW_NEGATIVE_PAIR_LOCK, true);
  assert.equal(params.PAIR_DISCOVERY_START_SECONDS, 21);
  assert.equal(params.PAIR_ACCUMULATION_START_SECONDS, 91);
  assert.equal(params.PAIR_ACCUMULATION_END_SECONDS, 211);
  assert.equal(params.PAIR_COMPLETION_END_SECONDS, 261);
  assert.equal(params.PAIR_RISK_REDUCTION_END_SECONDS, 286);
  assert.equal(params.REPLENISH_AHEAD_LEG, true);
  resetEnv();
});

test('V2 pair-cycle configuration rejects unsafe targets and regime order', () => {
  resetEnv({ PAIR_TARGET_MILS: '996', PAIR_HARD_MAX_MILS: '995' });
  assert.throws(
    () => buildStrategyConfig({ feeMode: 'paper' }),
    /pair-cycle/
  );
  resetEnv({
    PAIR_TARGET_MILS: '985',
    PAIR_HARD_MAX_MILS: '995',
    PAIR_ACCUMULATION_END_SECONDS: '270',
    PAIR_COMPLETION_END_SECONDS: '260',
  });
  assert.throws(
    () => buildStrategyConfig({ feeMode: 'paper' }),
    /pair-cycle/
  );
  resetEnv();
});

test('buildStrategyConfig paper matches env sizing and soft cap', () => {
  resetEnv({
    ENTRY_GATE_SECONDS: '20',
    MIN_ORDER_NOTIONAL_USD: '1.25',
    MIN_RUNG_SHARES: '5',
    MAX_RUNG_SHARES: '',
    MAX_LEG_SHARES: '15',
    DYNAMIC_SIZING: '1',
    ROUND_SOFT_CAP: '200',
    ROUND_HARD_CAP: '250',
    MAX_TILT_SHARES: '12',
    POLYMARKET_TAKER_FEE_RATE: '0.05',
    PAPER_FEE_BPS: '0',
    MIN_REQUOTE_INTERVAL_MS: '750',
  });

  const { params, guards, sim } = buildStrategyConfig({ feeMode: 'paper' });

  assert.equal(params.ENTRY_GATE_SECONDS, 20);
  assert.equal(params.MIN_ORDER_NOTIONAL_USD, 1.25);
  assert.equal(params.MIN_RUNG_SHARES, 5);
  assert.equal(params.MAX_RUNG_SHARES, PARAMS.MAX_RUNG_SHARES);
  assert.equal(params.MAX_LEG_SHARES, 15);
  assert.equal(params.DYNAMIC_SIZING_ENABLED, true);
  assert.equal(params.ASSUMED_FEE_BPS_OF_NOTIONAL, 0);
  assert.equal(guards.MAX_ROUND_NOTIONAL_USD.softLimit, 200);
  assert.equal(guards.MAX_ROUND_NOTIONAL_USD.hardLimit, 250);
  assert.equal(guards.MAX_TILT_SHARES, 12);
  assert.equal(sim.feeBps, 0);
  assert.equal(sim.takerFeeRate, 0.05);
  assert.equal(params.POLYMARKET_TAKER_FEE_RATE, 0.05);
  assert.equal(params.MIN_REQUOTE_INTERVAL_MS, 750);
  assert.equal(sim.placeLatencyMs, 600);
  assert.equal(sim.cancelLatencyMs, 600);
  assert.equal(sim.tradeFraction, 0.6);
  assert.equal(sim.queueAheadFactor, 1);

  resetEnv();
});

test('buildStrategyConfig live requires FEE_BPS', () => {
  resetEnv({
    FEE_BPS: '',
    MIN_RUNG_SHARES: '5',
    MAX_RUNG_SHARES: '20',
  });
  assert.throws(
    () => buildStrategyConfig({ feeMode: 'live' }),
    /FEE_BPS/
  );
  resetEnv({
    FEE_BPS: '10',
    MIN_RUNG_SHARES: '5',
    MAX_RUNG_SHARES: '20',
  });
  const { params } = buildStrategyConfig({ feeMode: 'live' });
  assert.equal(params.ASSUMED_FEE_BPS_OF_NOTIONAL, 10);
  resetEnv();
});

test('buildStrategyConfig defaults match PARAMS/GUARDS when knobs unset', () => {
  resetEnv({
    MIN_RUNG_SHARES: undefined,
    MIN_ORDER_NOTIONAL_USD: undefined,
    MAX_RUNG_SHARES: undefined,
    MAX_LEG_SHARES: undefined,
    ENTRY_GATE_SECONDS: undefined,
    PAPER_FEE_BPS: undefined,
    DYNAMIC_SIZING: undefined,
    ROUND_SOFT_CAP: undefined,
    ROUND_HARD_CAP: undefined,
    MAX_TILT_SHARES: undefined,
    POLYMARKET_TAKER_FEE_RATE: undefined,
    PAPER_PLACE_LATENCY_MS: undefined,
    PAPER_CANCEL_LATENCY_MS: undefined,
    PAPER_TRADE_FRACTION: undefined,
    PAPER_QUEUE_AHEAD: undefined,
    MIN_REQUOTE_INTERVAL_MS: undefined,
  });
  delete process.env.MIN_RUNG_SHARES;
  delete process.env.MIN_ORDER_NOTIONAL_USD;
  delete process.env.MAX_RUNG_SHARES;
  delete process.env.MAX_LEG_SHARES;
  delete process.env.ENTRY_GATE_SECONDS;
  delete process.env.PAPER_FEE_BPS;
  delete process.env.DYNAMIC_SIZING;
  delete process.env.ROUND_SOFT_CAP;
  delete process.env.ROUND_HARD_CAP;
  delete process.env.MAX_TILT_SHARES;
  delete process.env.POLYMARKET_TAKER_FEE_RATE;
  delete process.env.PAPER_PLACE_LATENCY_MS;
  delete process.env.PAPER_CANCEL_LATENCY_MS;
  delete process.env.PAPER_TRADE_FRACTION;
  delete process.env.PAPER_QUEUE_AHEAD;
  delete process.env.MIN_REQUOTE_INTERVAL_MS;

  const { params, guards, sim } = buildStrategyConfig({ feeMode: 'paper' });
  assert.equal(params.MIN_RUNG_SHARES, PARAMS.MIN_RUNG_SHARES);
  assert.equal(
    params.MIN_ORDER_NOTIONAL_USD,
    PARAMS.MIN_ORDER_NOTIONAL_USD
  );
  assert.equal(params.MAX_LEG_SHARES, PARAMS.MAX_LEG_SHARES);
  assert.equal(params.ENTRY_GATE_SECONDS, PARAMS.ENTRY_GATE_SECONDS);
  assert.equal(
    guards.MAX_ROUND_NOTIONAL_USD.softLimit,
    GUARDS.MAX_ROUND_NOTIONAL_USD.softLimit
  );
  assert.equal(
    guards.MAX_ROUND_NOTIONAL_USD.hardLimit,
    GUARDS.MAX_ROUND_NOTIONAL_USD.hardLimit
  );
  assert.equal(guards.MAX_TILT_SHARES, GUARDS.MAX_TILT_SHARES);
  assert.equal(sim.takerFeeRate, 0.07);
  assert.equal(params.POLYMARKET_TAKER_FEE_RATE, 0.07);
  assert.equal(params.MIN_REQUOTE_INTERVAL_MS, 500);
  assert.equal(sim.placeLatencyMs, 600);
  assert.equal(sim.cancelLatencyMs, 600);
  assert.equal(sim.tradeFraction, 0.6);
  assert.equal(sim.queueAheadFactor, 1);

  resetEnv();
});

test('buildStrategyConfig rejects a notional floor below Polymarket minimum', () => {
  resetEnv({ MIN_ORDER_NOTIONAL_USD: '0.99' });
  assert.throws(
    () => buildStrategyConfig({ feeMode: 'paper' }),
    /dynamic sizing/
  );
  resetEnv();
});

test('buildStrategyConfig rejects invalid PAPER_TRADE_FRACTION', () => {
  resetEnv({ PAPER_TRADE_FRACTION: '0' });
  assert.throws(
    () => buildStrategyConfig({ feeMode: 'paper' }),
    /PAPER_TRADE_FRACTION/
  );
  resetEnv({ PAPER_TRADE_FRACTION: '1.5' });
  assert.throws(
    () => buildStrategyConfig({ feeMode: 'paper' }),
    /PAPER_TRADE_FRACTION/
  );
  resetEnv();
});

test('V3 defaults preserve V2 and active execution fails closed at this milestone', () => {
  resetEnv({ V3_ENABLED: '0', V3_SHADOW_ONLY: '1' });
  const { params } = buildStrategyConfig({ feeMode: 'paper' });
  assert.equal(params.V3_ENABLED, false);
  assert.equal(params.V3_SHADOW_ONLY, true);
  assert.equal(params.DIRECTIONAL_ENABLED, false);
  resetEnv({ V3_ENABLED: '1', V3_SHADOW_ONLY: '0' });
  assert.throws(
    () => buildStrategyConfig({ feeMode: 'paper' }),
    /shadow-ready milestone/
  );
  resetEnv();
});
