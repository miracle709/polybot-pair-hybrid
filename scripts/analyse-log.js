#!/usr/bin/env node
/**
 * Rebuilds the reconstruction's checklist from the activity log.
 *
 * Works on paper-simulation and live logs.
 *
 *   node scripts/analyse-log.js logs/activity-*.jsonl
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { EventType } from '../src/log/schema.js';
import { PARAMS } from '../src/config.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/analyse-log.js <activity.jsonl...>');
  process.exit(1);
}

console.warn(
  'WARNING: logs and simulated PnL are diagnostic evidence only; ' +
  'do not use them to conclude profitability or overall strategy quality.'
);

const rounds = new Map();
const fills = [];
const placed = [];
const cancelled = [];
const intents = [];
const ptb = [];
const snaps = [];
const health = [];
const halts = [];
const restarts = [];
const suppression = new Map();
let rejected = 0;

for (const file of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let firstOpen = null;
  for await (const line of rl) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    switch (e.type) {
      case EventType.ROUND_OPEN: if (!firstOpen) firstOpen = e.rid; break;
      case EventType.PRICE_TO_BEAT: ptb.push(e); break;
      case EventType.BOOK_SNAPSHOT: snaps.push(e); break;
      case EventType.HEALTH: health.push(e); break;
      case EventType.HALT: halts.push(e); break;
      case EventType.QUOTE_INTENT:
        intents.push(e);
        for (const s of e.sup ?? []) suppression.set(s, (suppression.get(s) ?? 0) + 1);
        break;
      case EventType.ORDER_PLACED: placed.push(e); break;
      case EventType.ORDER_CANCELLED: cancelled.push(e); break;
      case EventType.ORDER_REJECTED: rejected += 1; break;
      case EventType.FILL: fills.push(e); break;
      case EventType.ROUND_SETTLED: rounds.set(e.rid, e); break;
      default: break;
    }
  }
  if (firstOpen) restarts.push(firstOpen);
}

const med = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const q = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
const pctS = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const chk = (ok, v, target) => `${ok ? 'OK ' : 'XX '} ${String(v).padEnd(16)} ${target}`;

console.log('mode: PAPER/LIVE');
console.log(`files ${files.length}  process starts ${restarts.length}  rounds seen ${new Set(intents.map((i) => i.rid)).size}`);
console.log(`intents ${intents.length} (deduped: one per change + heartbeat)  snapshots ${snaps.length}`);
console.log(`placed ${placed.length}  cancelled ${cancelled.length}  rejected ${rejected}  fills ${fills.length}  settled ${rounds.size}`);

// ------------------------------------------------------------------- health
if (health.length || halts.length) {
  console.log('\n== health ==');
  const maxLive = Math.max(0, ...health.map((h) => h.liveOrders ?? 0));
  const stale = Math.max(0, ...health.map((h) => h.staleBooksDropped ?? 0));
  const resyncs = health.flatMap((h) => (h.market ?? []).map((m) => m.resyncs ?? 0));
  const dropped = health.map((h) => h.recorder?.dropped ?? 0);
  const unhealthy = health.filter((h) => h.userFeedHealthy === false).length;
  console.log(`  samples ${health.length}  halts ${halts.length}`);
  console.log(`  peak live orders    ${chk(maxLive <= 4, maxLive, '[target <=4 = LADDER_LEVELS*2]')}`);
  console.log(`  stale books dropped ${stale}   [>0 means rollover raced; should be rare]`);
  console.log(`  feed resyncs        ${Math.max(0, ...resyncs)}`);
  console.log(`  user feed down      ${chk(unhealthy === 0, `${unhealthy}/${health.length} samples`, '[target 0]')}`);
  console.log(`  log events dropped  ${chk(Math.max(0, ...dropped) === 0, Math.max(0, ...dropped), '[target 0]')}`);
  for (const h of halts) console.log(`  HALT: ${h.reason}`);
}

// ---------------------------------------------------------------- quoting
console.log('\n== quoting ==');
const offs = placed.map((p) => p.off).filter((x) => x != null);
const offHist = offs.reduce((h, o) => ((h[o] = (h[o] ?? 0) + 1), h), {});
console.log(`  offset behind bid   ${chk(med(offs) === 1, `med ${med(offs)}`, `[target 1]  ${JSON.stringify(offHist)}`)}`);
const sizes = [...new Set(placed.map((p) => p.sh))];
console.log(`  rung size           ${chk(sizes.length === 1 && sizes[0] <= 90, sizes.join(','), '[target one value, <=90]')}`);
const oob = placed.filter((p) => p.p < 120 || p.p > 890).length;
console.log(`  posted outside band ${chk(oob === 0, oob, '[target 0]')}`);
const legs = placed.reduce((h, p) => ((h[p.leg] = (h[p.leg] ?? 0) + 1), h), {});
console.log(`  leg balance         ${JSON.stringify(legs)}`);
const roundsSeen = new Set(intents.map((i) => i.rid)).size || 1;
console.log(`  placements/round    ${(placed.length / roundsSeen).toFixed(0)}   [wallet: ~30 fills/round at ~90% cancel rate => ~300 placements]`);
const ages = cancelled.map((c) => c.age_ms).filter((x) => x != null);
if (ages.length) {
  const stale = ages.filter((a) => a > 10000).length;
  console.log(`  age at cancel (ms)  p50 ${med(ages)}  p90 ${q(ages, 0.9)}  p99 ${q(ages, 0.99)}  max ${Math.max(...ages)}`);
  console.log(`    over 10s: ${pctS(stale, ages.length)}  — a rung correctly rests while the touch does not move.`);
  console.log('    NOT comparable to the wallet\'s 0-3s figure: that was age at FILL, not at cancel.');
}

// ------------------------------------------------------------- entry gate
console.log('\n== entry gate ==');
const firstSec = new Map();
for (const i of intents) if (!firstSec.has(i.rid) || i.sec < firstSec.get(i.rid)) firstSec.set(i.rid, i.sec);
const joins = [...firstSec.values()].sort((a, b) => a - b);
const clean = joins.filter((s) => s <= 15).length;
const entryGate = Number(process.env.ENTRY_GATE_SECONDS ?? PARAMS.ENTRY_GATE_SECONDS);
const beforeGate = placed.filter((p) => p.sec < entryGate).length;
console.log(`  earliest intent per round: ${joins.join(', ')}`);
console.log(`  placements before t=${entryGate}  ${chk(beforeGate === 0, beforeGate, '[target 0]')}`);
if (clean === 0) {
  console.log(`  !! no round joined from the start — the t=${entryGate} gate is UNTESTED here.`);
  console.log('     Every round was joined mid-flight, i.e. after a restart. Run');
  console.log('     unattended across several clean round boundaries.');
} else {
  console.log(`  rounds joined from open: ${clean}/${joins.length}`);
}

// -------------------------------------------------------- band gate/round
console.log('\n== band gate, per round ==');
console.log('  round                          intents  sec range    gated   med mid  placed');
const byRid = new Map();
for (const i of intents) {
  if (!byRid.has(i.rid)) byRid.set(i.rid, []);
  byRid.get(i.rid).push(i);
}
let gatedTotal = 0;
const perRound = [];
for (const [rid, rs] of [...byRid].sort()) {
  const secs = rs.map((r) => r.sec);
  const gated = rs.filter((r) => r.n === 0).length;
  gatedTotal += gated;
  const mids = rs.filter((r) => r.up_bid && r.up_ask).map((r) => (r.up_bid + r.up_ask) / 2);
  const p = placed.filter((x) => x.rid === rid).length;
  perRound.push({ rid, n: rs.length, gated: gated / rs.length });
  console.log(
    `  ${rid.padEnd(31)}${String(rs.length).padStart(6)}  ${String(Math.min(...secs)).padStart(3)}-${String(Math.max(...secs)).padEnd(5)}` +
      `${pctS(gated, rs.length).padStart(8)}  ${String(med(mids)).padStart(7)}  ${String(p).padStart(5)}`
  );
}
console.log(`  overall gated: ${pctS(gatedTotal, intents.length)}`);
const trendy = perRound.filter((r) => r.gated > 0.6);
if (trendy.length) {
  const rest = perRound.filter((r) => r.gated <= 0.6);
  const n = rest.reduce((s, r) => s + r.n, 0);
  const g = rest.reduce((s, r) => s + r.gated * r.n, 0);
  console.log(`  ${trendy.length} one-way round(s) dominate that: ${trendy.map((r) => r.rid.slice(-10)).join(', ')}`);
  console.log(`  excluding them: ${pctS(g, n)}   [wallet: 13.4% whipsaw / 40.8% trend]`);
}
if (suppression.size) {
  console.log('  suppression reasons:');
  for (const [k, v] of [...suppression].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`    ${String(v).padStart(7)}  ${k}`);
  }
}

// ----------------------------------------------------------- price to beat
console.log('\n== price to beat ==');
if (!ptb.length) {
  console.log('  none logged — nothing is calling setPriceToBeat().');
  console.log('  Pass a priceToBeatProvider to the Supervisor (src/live/priceToBeat.js).');
} else {
  const srcs = ptb.reduce((h, e) => ((h[e.ptb_src] = (h[e.ptb_src] ?? 0) + 1), h), {});
  console.log(`  ${ptb.length} captured, sources ${JSON.stringify(srcs)}`);
  const drift = ptb.filter((e) => e.bnc_btc && e.ptb).map((e) => e.bnc_btc - e.ptb);
  if (drift.length) {
    console.log(`  binance minus strike: med $${med(drift).toFixed(1)}  [capture ~$60 — never substitute one for the other]`);
  }
}

// ------------------------------------------------------------------- fills
console.log('\n== fills ==');
if (!fills.length) {
  console.log('  none recorded.');
} else {
  const roles = fills.reduce((h, f) => ((h[f.role ?? 'unknown'] = (h[f.role ?? 'unknown'] ?? 0) + 1), h), {});
  const fOffs = fills.map((f) => f.off).filter((x) => x != null);
  const swept = fills.filter((f) => f.off < 0).length;
  const fee = fills.reduce((s, f) => s + (f.fee ?? 0), 0);
  const notional = fills.reduce((s, f) => s + (f.usd ?? 0), 0);
  const maxSh = Math.max(...fills.map((f) => f.sh));
  const outside = fills.filter((f) => f.p < 120 || f.p > 890).length;
  console.log(`  roles ${JSON.stringify(roles)}`);
  console.log(`  offset at fill      ${chk(med(fOffs) === 1, `med ${med(fOffs)}`, '[target 1]')}`);
  console.log(`  swept (above bid)   ${chk(swept / fills.length < 0.08, pctS(swept, fills.length), '[target <8%; wallet 13.7%]')}`);
  console.log(`  max single fill     ${chk(maxSh <= 90.001, maxSh, '[target <=90]')}`);
  console.log(`  outside band        ${chk(outside === 0, outside, '[target 0]')}`);
  console.log(`  fees paid           $${fee.toFixed(4)}  (${notional ? ((fee / notional) * 10000).toFixed(1) : 0} bps of notional)`);
  console.log(`  cancels per fill    ${(cancelled.length / fills.length).toFixed(1)}   [wallet ~9:1]`);
}

// --------------------------------------------------------- settled rounds
console.log('\n== settled rounds ==');
const R = [...rounds.values()];
if (!R.length) {
  console.log('  none. Rounds settle only when onResolution() is called with a winner.');
} else {
  const pnl = R.map((r) => r.pnl_usd);
  const total = pnl.reduce((a, b) => a + b, 0);
  const mean = total / pnl.length;
  const sd = Math.sqrt(pnl.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, pnl.length - 1));
  const cost = R.reduce((s, r) => s + r.cost_usd, 0);
  const pairs = R.map((r) => r.pair).filter((x) => x != null);
  const tilted = R.filter((r) => Math.abs(r.tilt) > 1);
  const aligned = tilted.filter((r) => (r.tilt > 0) === (r.outcome === 'UP')).length;
  const al = aligned / (tilted.length || 1);
  console.log(`  median pair cost    ${chk(med(pairs) <= 992, med(pairs).toFixed(1), '[target <=992 mils]')}`);
  console.log(`  pair cost < 1.00    ${chk(pairs.filter((x) => x < 1000).length / pairs.length >= 0.54, pctS(pairs.filter((x) => x < 1000).length, pairs.length), '[target >=54%]')}`);
  console.log(`  tilt vs winner      ${chk(al >= 0.45 && al <= 0.55, pctS(aligned, tilted.length), '[target 48-52%, must be a coinflip]')}`);
  console.log(`  pnl $${total.toFixed(2)} on $${cost.toFixed(2)} deployed (${cost ? ((100 * total) / cost).toFixed(2) : 0}%)`);
  console.log(`  per round $${mean.toFixed(2)} +/- ${sd.toFixed(2)}   t=${sd ? (mean / (sd / Math.sqrt(R.length))).toFixed(2) : 0}`);
  if (R.length < 200 && sd > 0) {
    console.log(`  ~${Math.ceil(((2 * sd) / Math.max(0.01, Math.abs(mean))) ** 2)} rounds needed for t=2. The wallet's own edge is t=1.94 over 633.`);
  }
}
