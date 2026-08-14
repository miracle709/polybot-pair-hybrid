#!/usr/bin/env node
/**
 * Three measurements that together answer "does logging slow the engine":
 *   1. record() in isolation — the only thing on the hot path
 *   2. a full quote cycle at REALISTIC event rates
 *   3. worst-case burst: how long is the longest single stall
 */
import { ActivityRecorder, NullRecorder } from '../src/log/recorder.js';
import * as ev from '../src/log/schema.js';
import { computeDesiredRungs } from '../src/quoter.js';
import { LegBook, MarketBook } from '../src/book.js';
import { RoundInventory } from '../src/inventory.js';
import { GUARDS } from '../src/config.js';
import fs from 'node:fs';

const mk = (bb) => {
  const bids = [], asks = [];
  for (let i = 0; i < 30; i++) {
    if (bb - i >= 1) bids.push({ price: (bb - i) / 100, size: 300 + i });
    if (bb + 1 + i <= 99) asks.push({ price: (bb + 1 + i) / 100, size: 300 + i });
  }
  return new LegBook(bids, asks, 0);
};
const books = new MarketBook(mk(50), mk(49));
const inv = new RoundInventory('btc-updown-5m-1785140700', 1785140700);
const guards = structuredClone(GUARDS);
const RID = 'btc-updown-5m-1785140700';
const MKT = { up_bid: 500, up_ask: 510, dn_bid: 490, dn_ask: 500 };
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const us = (n) => n.toFixed(3) + 'us';

fs.rmSync('/tmp/benchlogs', { recursive: true, force: true });
const rec = new ActivityRecorder({ dir: '/tmp/benchlogs', flushMs: 250, capacity: 65536 });
const sample = ev.quoteIntent(RID, 100, computeDesiredRungs({ secondsIntoRound: 100, books, inventory: inv, guards }).rungs, [], MKT);

// ---- 1. record() alone -----------------------------------------------------
{
  const N = 500000;
  for (let i = 0; i < 50000; i++) rec.record(sample);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) rec.record(sample);
  const total = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`1. record() alone      ${(total * 1000 / N).toFixed(4)}us per call  (${(N / total * 1000 / 1e6).toFixed(1)}M calls/sec)`);
}

// ---- 2. full cycle at a realistic rate -------------------------------------
// The engine sees ~108 book updates per 300s round x 2 legs => ~1/sec.
// Benchmark at 500/sec, ~700x reality, to leave no doubt.
async function paced(label, recorder) {
  const N = 20000, lat = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = process.hrtime.bigint();
    const { rungs, suppressed } = computeDesiredRungs({ secondsIntoRound: 100, books, inventory: inv, guards });
    recorder.record(ev.quoteIntent(RID, 100, rungs, suppressed, MKT));
    lat[i] = Number(process.hrtime.bigint() - s) / 1000;
    if (i % 500 === 0) await new Promise((r) => setImmediate(r));
  }
  const s = Float64Array.from(lat).sort();
  console.log(`   ${label.padEnd(14)} p50 ${us(pct(s, .5))}  p99 ${us(pct(s, .99))}  p99.9 ${us(pct(s, .999))}  max ${us(s[N - 1])}`);
  return pct(s, .99);
}
console.log('2. full quote cycle, paced (500/sec)');
const offP99 = await paced('logging OFF', NullRecorder);
const onP99 = await paced('logging ON', rec);
console.log(`   p99 delta: ${us(onP99 - offP99)}`);

// ---- 3. worst-case burst ---------------------------------------------------
{
  for (let i = 0; i < 60000; i++) rec.record(sample);
  let maxStall = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    const s = process.hrtime.bigint();
    await new Promise((r) => setImmediate(r));
    const d = Number(process.hrtime.bigint() - s) / 1e6;
    if (d > maxStall) maxStall = d;
  }
  console.log(`3. burst drain (60k queued)  longest event-loop stall ${maxStall.toFixed(2)}ms`);
}

// ---- 4. REALISTIC rate: what the engine actually does ---------------------
{
  const rec2 = new ActivityRecorder({ dir: '/tmp/benchlogs2', flushMs: 250 });
  // ~108 book updates per 300s round, both legs, plus fills => ~2 events/sec.
  // Run 3000 cycles at 200/sec, i.e. 100x the real rate.
  const N = 3000, lat = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = process.hrtime.bigint();
    const { rungs, suppressed } = computeDesiredRungs({ secondsIntoRound: 100, books, inventory: inv, guards });
    rec2.record(ev.quoteIntent(RID, 100, rungs, suppressed, MKT));
    lat[i] = Number(process.hrtime.bigint() - s) / 1000;
    await new Promise((r) => setTimeout(r, 5));
  }
  const s2 = Float64Array.from(lat).sort();
  console.log(`4. realistic rate (200/sec, ~100x live)  p50 ${us(pct(s2, .5))}  p99 ${us(pct(s2, .99))}  max ${us(s2[N - 1])}  dropped ${rec2.health().dropped}`);
  await rec2.close();
}

await rec.close();
const h = rec.health();
console.log(`\nrecorded ${h.recorded}  written ${h.written}  dropped ${h.dropped}  peak ${h.maxDepth}/${h.capacity}`);
const f = fs.readdirSync('/tmp/benchlogs')[0];
console.log(`file ${(fs.statSync('/tmp/benchlogs/' + f).size / 1e6).toFixed(1)}MB`);
