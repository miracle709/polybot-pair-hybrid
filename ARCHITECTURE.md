# Architecture

## Layering

Four layers, each depending only on the ones above it. Nothing in `strategy`
knows about Polymarket; nothing in `domain` knows about I/O.

```
config          config.js
                measured parameters plus V2 pair-cycle and risk constraints.
                        │
domain          util.js · book.js · inventory.js · pairEconomics.js
                prices, books, immutable FIFO lots, complement economics.
                Pure. No I/O, no venue concepts, fully unit-testable.
                        │
strategy        quoter.js · orderManager.js · roundRunner.js · engine.js
                the decision surface and its lifecycle.
                Talks to the venue only through ExchangeAdapter.
                        │
        ┌───────────────┴────────────────┐
adapters │                                │
        exchange/paperExchange.js    exchange/polymarketLive.js
        (paper + JSONL replay)       (live CLOB)
                                            │
infrastructure                        live/*.js
                                feeds · bookState · marketResolver
                                rateLimiter · supervisor · statusServer

cross-cutting   log/recorder.js · log/schema.js
                injected downward, never imported upward
```

The important property: **`quoter.js` is a pure function.** Same inputs, same
rungs, no clock reads, no network, no hidden state. That is what makes the
strategy testable in isolation and what lets `replay.js` run the *identical*
code path as live trading rather than a reimplementation of it.

V1 and V2 share every infrastructure layer. V1 independently accumulated both
legs and treated global average pair cost as telemetry. V2 changes the domain
and decision layers only: fills become immutable FIFO lots, completed pairs are
frozen, and `quoter.js` calls pure complement-cap helpers before emitting a
completion or neutral two-leg cycle.

## Data flow, live

```
market WS ──► BookState ──► MarketFeed ──► Supervisor ──► Engine
                (deltas)      (MarketBook)                   │
                                                             ▼
user WS ─────► UserFeed ────────────────► Supervisor ──► RoundRunner
                (private fills)                              │
                                              ┌──────────────┴──────────────┐
                                              ▼                             ▼
                                     RoundInventory              computeDesiredRungs
                                  (FIFO lots, frozen pairs)       (regime + lot caps)
                                                                            │
                                                                            ▼
                                                                    OrderManager
                                                            (diff desired vs live)
                                                                            │
                                                                            ▼
                                                             RateLimiter ──► CLOB
```

`ActivityRecorder` hangs off `RoundRunner` and `OrderManager` and receives
events at every step. It is injected, never constructed by them, so any of
these can be driven with `NullRecorder` in tests at zero cost.

## Data flow, replay

Identical, with two substitutions:

```
events_*.jsonl ──► LegBook ──► MarketBook ──► RoundRunner ──► PaperExchange
                                                    ▲               │
                                                    └── fills ──────┘
```

`PaperExchange` fills resting orders from bid-queue shrinkage between
snapshots, then `RoundRunner.onBook` reprices. Ordering matters: the market
moves, you get hit, *then* you react. Reversing it silently deletes all
adverse selection from the backtest.

The paper model is queue-aware, latency-aware, and has no look-ahead, but it is
not calibrated to LIVE adverse selection and does not validate profitability.
`MAKER_MARKOUT` events at 250/500/1000/2000/5000 ms provide the calibration
input for a later phase.

## Round lifecycle

```
t = 0      round opens. Book already 1c wide, strike already published.
t < 20     WARMUP. Zero orders (PAIR_DISCOVERY_START_SECONDS).
t < 90     DISCOVERY. Small, jointly-economic neutral cycles.
t < 210    ACCUMULATION. Normal finite pair cycles.
t < 260    COMPLETION. Prefer unmatched complements; minimum new size.
t < 285    RISK_REDUCTION. No large new unmatched inventory.
t < 300    CLOSE_ONLY. Economic complements only; never force a hedge.
           Neutral: require both in-band legs, cap each side's total exposure,
           and validate the worst opening UP+DOWN rung combination.
           Unmatched: suppress/latch the ahead leg and derive the opposite
           limit from FIFO lot cost, target, execution buffer, and fee.
t = 300    SETTLING. All orders cancelled. Both legs held.
resolution DONE. Winning shares held; never sold.
```

## Concurrency and ordering rules

Four that are load-bearing and easy to break:

1. **Cancels outrank places** in `RateLimiter` (priority 0 vs 1). A cancel
   queued behind a burst of places is a stale rung resting in a moving
   market — the −22.3% ROI bucket, self-inflicted.
2. **Cancels are issued before places** inside `OrderManager.reconcile`.
   Frees collateral and avoids per-market order-count limits when the touch
   walks and every rung reprices at once.
3. **Logging never applies backpressure.** `record()` pushes to a bounded
   ring and returns. Under pressure the *log* degrades, never the strategy.
4. **Reconciliation coalesces latest state.** While one network pass is busy,
   each book update replaces `pendingDesired`. The active pass immediately
   processes the single newest state afterward; intermediate states are never
   queued and cannot create duplicate orders.

LIVE maker markout timers are unref'd and only read the latest cached book
before pushing a recorder event. They never await or block fill handling.

## Failure model

| failure | detection | response |
|---|---|---|
| market WS closes | socket `close` | mark all books resync, flatten quotes |
| market WS silent | 15s watchdog | `halt()` |
| delta stream corrupt | crossed book / unknown shape | resync flag, serve no book |
| user WS drops | socket `close` | stop quoting — never trade blind |
| unexpected SELL | user feed | `halt()`; something else is on this account |
| repeated errors | 20 consecutive | `halt()` |
| open notional breach | on every fill | `halt()` |
| pair hard-max breach | after fill + before quotes | cancel quotes; recoverable strategy pause |
| unmatched share/age breach | after fill + before quotes | suppress new/ahead cycles; economic complement only |
| Auto Balance ask above cap | pre-FAK lot/depth check | cancel makers; return `hedge_not_economic`; keep paused |
| order below 5 shares or $1 | allocation + pre-submit checks | consolidate or suppress; never send an invalid order |
| Auto Balance residual below venue minimum | pre-FAK check | do not overbuy; return `hedge_below_venue_minimum`; keep paused |
| daily loss breach | on resolution | `halt()` |
| process restart | boot | cancel every pre-existing order before quoting |

`halt()` cancels and stops. It never liquidates: the strategy has no sell
path, and inventing one under stress turns a bad day into a bad week.

Strategy-level economic pauses are intentionally not fatal supervisor halts.
They keep the process, feeds, settlement, dashboard, and diagnostics alive.

## Where to change things

| you want to | edit |
|---|---|
| change a strategy parameter | `src/config.js` — nothing else |
| change complement economics | `src/pairEconomics.js` plus boundary tests |
| pair-cycle bounds | `PAIR_TARGET_MILS`, buffer/hard max, unmatched share/age limits |
| add a decision rule | `src/quoter.js` — and add a test asserting it |
| support another venue | implement `ExchangeAdapter`; touch nothing above |
| add a logged field | `src/log/schema.js`, then `scripts/analyse-log.js` |
| change fill simulation | `src/exchange/paperExchange.js` — read its caveats first |

If a change to strategy behaviour does not require editing `quoter.js` or
`config.js`, it is probably in the wrong layer.
