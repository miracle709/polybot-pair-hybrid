import fs from 'node:fs';
import readline from 'node:readline';
import { LegBook, MarketBook } from './book.js';
import { PaperExchange } from './exchange/paperExchange.js';
import { RoundRunner } from './roundRunner.js';
import { PARAMS, GUARDS } from './config.js';
import { summarise, report } from './metrics.js';
import { windowStartFromSlug } from './util.js';

/**
 * Replays captured TICK snapshots through the live strategy code.
 *
 * Input format is the capture already on disk:
 *   events_part*.jsonl  — {"type":"TICK", round_slug, seconds_into_round,
 *                          up_book:{bids,asks}, down_book:{bids,asks}, ...}
 *                         and {"type":"ROUND_RESULT", round_slug, winner}
 *
 * Same quoter, same order manager, same round runner as live. The only
 * substitution is PaperExchange for the CLOB.
 */
export async function replay({ files, params = PARAMS, guards = GUARDS, sim = {}, onRound = null }) {
  const exchange = new PaperExchange(sim);

  /** @type {Map<string, RoundRunner>} */
  const runners = new Map();
  const winners = new Map();
  const results = [];
  const allFills = [];

  const finish = async (slug) => {
    const runner = runners.get(slug);
    if (!runner) return;
    const winner = winners.get(slug);
    if (!winner) return;
    const res = await runner.settle(winner);
    results.push(res);
    if (onRound) onRound(res);
    runners.delete(slug);
  };

  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }

      if (ev.type === 'ROUND_RESULT') {
        const w = normaliseWinner(ev.winner ?? ev.market_winner);
        if (w) {
          winners.set(ev.round_slug, w);
          await finish(ev.round_slug);
        }
        continue;
      }

      if (ev.type !== 'TICK') continue;
      if (!ev.up_book?.bids?.length || !ev.down_book?.bids?.length) continue;

      const slug = ev.round_slug;
      const ts = ev.ts;
      let runner = runners.get(slug);
      if (!runner) {
        exchange.setMarket({
          roundSlug: slug,
          tokenIds: { UP: 'UP', DOWN: 'DOWN' },
        });
        runner = new RoundRunner({
          roundSlug: slug,
          windowStartEpoch: windowStartFromSlug(slug),
          tokenIds: { UP: 'UP', DOWN: 'DOWN' },
          exchange,
          params,
          guards,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        });
        exchange.setFillHandler((fill) => {
          const t = Math.floor(fill.ts - runner.windowStartEpoch);
          runner.onFill(fill);
          allFills.push({
            roundSlug: slug,
            leg: fill.leg,
            price: fill.price,
            size: fill.size,
            side: 'BUY',
            secondsIntoRound: t,
            offsetTicks: fill.offsetTicks,
          });
        });
        runners.set(slug, runner);
      }

      const up = new LegBook(ev.up_book.bids, ev.up_book.asks, ts);
      const down = new LegBook(ev.down_book.bids, ev.down_book.asks, ts);
      const books = new MarketBook(up, down);

      exchange.setClock(ts * 1000);

      // Fill resting orders against this snapshot BEFORE requoting.
      exchange.onMarketBook(books, ts, slug);

      await runner.onBook(books, ts, ts * 1000);
    }
  }

  for (const slug of [...runners.keys()]) await finish(slug);

  const summary = summarise(results, allFills, { params });
  return { summary, results, fills: allFills, text: report(summary) };
}

function normaliseWinner(w) {
  if (!w) return null;
  const s = String(w).toUpperCase();
  if (s === 'UP' || s === 'DOWN') return s;
  return null;
}
