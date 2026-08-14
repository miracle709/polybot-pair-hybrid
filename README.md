# poly-btc5m-pair-mm

Node.js implementation of the strategy reconstructed from Polymarket wallet
`0x3048d65321be3497164cdfc2996f94f98a2e7537` on `btc-updown-5m-*` markets.

Derived from 1,473 rounds / 124.2h of fills (40,718 buys, **0 sells**),
161,808 one-second L2 book snapshots and 641 scored rounds.

## Active strategy: V2 finite pair cycles

The repository preserves the V1 feeds, adapters, resolver, supervisor,
settlement, logging, replay, and UI, but the active quote decision is V2.

- **V1** was an unrestricted two-sided accumulator. It measured
  `avg(UP) + avg(DOWN)` after fills but did not enforce the marginal economics
  of the fill that completed each pair. Balanced inventory could therefore
  cost more than its guaranteed $1.00 payout.
- **V2** represents every buy as an immutable FIFO lot. Completed pair records
  are frozen, the ahead leg is suppressed, and the complementary limit is
  capped from the exact unmatched lot cost, fee reserve, and execution buffer.
  `pairCostMils()` remains visible for compatibility but is not the primary
  control variable.

V2 does not claim profitability. Its immediate goal is to make deliberate
structurally uneconomic pair completion impossible under the configured hard
constraints and to collect LIVE markouts for later edge calibration.

## V1 reconstruction background (superseded control logic)

A passive two-sided pair accumulator. It posts resting buy limits on **both**
the UP and DOWN tokens, one tick behind each leg's best bid. The source wallet
used fixed 90-share parent rungs; this deployment uses bounded dynamic sizing.
It never sells. Every matched UP+DOWN pair redeems for exactly $1.00,
so the trade is profitable whenever `avg(UP) + avg(DOWN) < 1.00`. The book is
1c wide 96% of the time (`bidUp + bidDown = 0.99`), which sets a ~1c floor
edge; most of the realised edge comes from intra-round mean reversion, not
the spread.

There is no signal, no forecast and no directional view. Share-tilt aligns
with the winner 47.9% of the time — a coinflip.

## Layout

```
src/
  config.js              every parameter, tagged [M] measured / [I] inferred / [U] unknown
  util.js                mil-based price arithmetic, variable tick size
  book.js                LegBook / MarketBook — touch, depth, complement mirroring
  inventory.js           aggregate plus immutable FIFO lot/pair accounting
  pairEconomics.js       pure complement-cap and fee-buffer calculations
  quoter.js              THE DECISION SURFACE — pure function, no I/O
  orderManager.js        diff desired vs live rungs; cancel, place, replenish
  roundRunner.js         per-round state machine WARMUP → QUOTING → SETTLING
  engine.js              round scheduling, feed routing, fee preflight
  replay.js              drives the live code over captured events_part*.jsonl
  metrics.js             the validation checklist
  exchange/
    interface.js         ExchangeAdapter contract
    paperExchange.js     queue-aware paper + JSONL L2 fill simulator
    polymarketLive.js    live-only CLOB adapter with capability probe
  live/
    feeds.js             market + user websockets, reconnect, staleness watchdog
    bookState.js         snapshot + delta application, resync detection
    marketResolver.js    Gamma API window → slug / conditionId / tokenIds
    priceToBeat.js       Chainlink strike sources (tracker HTTP / on-chain)
    rateLimiter.js       token bucket; cancels always outrank places
    supervisor.js        boot resync, kill switch, round rollover, risk rails
    statusServer.js      local dashboard HTTP
  log/
    recorder.js          non-blocking JSONL ring-buffer recorder
    schema.js            typed event builders
scripts/
  run-live.js            paper (default) and live entry point
  run-replay.js          backtest against your capture
  strategyConfig.js      shared .env → params/guards/sim builder
  analyse-log.js         rebuild the validation checklist from your own fills
  bench-recorder.js      prove the logging-overhead claim yourself
test/
  *.test.js              node:test suite (quoter, live, paper, recorder, …)
```

`quoter.js` is the file to read. Everything the wallet does is in it, and it
is genuinely that small: two gates and an offset. `STRATEGY.md` explains the
algorithm in depth; `ARCHITECTURE.md` covers layering, data flow and the
failure model.

## Quick start

```bash
npm test                                   # full suite, no network needed
npm run replay -- events_part3.jsonl       # backtest against your capture
npm run bench                              # logging overhead measurements
npm run paper                              # live book with simulated execution
```

## Run it

```bash
node --test test/*.test.js
node scripts/run-replay.js events_part3.jsonl
```

## The parameters

| # | parameter | value | conf |
|---|---|---|---|
| P1 | entry gate | **t ≥ 20s**, then passive two-sided quoting | target-aligned opening control |
| P2 | quote stop | **t = 300s** | [M] target keeps quoting until round expiry |
| P3 | band gate | **0.12 – 0.89** on the leg's mid | [M] activity −77% at 0.89–0.95, −98% above 0.95 |
| P4 | placement | **best bid − 1 tick** | [M] median 1 in *every* state tested |
| P5 | source-wallet rung | **90 shares**, never conditioned | [M] all size correlations < 0.06 |
| P6 | ladder depth | 2 levels/leg | [I] 76% of fill bursts touch one level |
| P7 | sizing | 10% depth allocation, capped by `MAX_UNMATCHED_SHARES=10` per cycle | V2 safety rail |
| P8 | exit | hold to resolution | [M] 0 sells, Closing Line Holds = 0 |
| P9 | fees | **unknown — you must set this** | [U] see below |

Sizing is in **shares, not notional**: median clip is 32–37 shares in every
price bucket while median USD scales 5 → 32 with price. The observed decay in
clip size across a round (33.5 shares on the opening fill, 12–18 in the last
minute) is *partial-fill censoring*, not a taper rule — p90 clip is exactly
90.0 in every time bucket and every price bucket. Do not implement a taper.

V2 economics defaults are `PAIR_TARGET_MILS=985`,
`PAIR_EXECUTION_BUFFER_MILS=5`, `PAIR_HARD_MAX_MILS=995`,
`MAX_UNMATCHED_SHARES=10`, and `MAX_UNMATCHED_AGE_SECONDS=60`.

## The fee question — read before deploying

`Engine.preflight()` throws until you set `ASSUMED_FEE_BPS_OF_NOTIONAL`.

Every one of his 9,032 observed fills carries `fee: 0.0`, and his realised PnL
reconciles to `payoff − cost` with a median residual of $0.000035. But a
third-party dashboard models fees at ~1.15% of volume. His gross edge is ~1.9%
of deployed USDC. **A real 1.15%-of-volume fee is roughly twice his entire
gross edge** and turns +9%/day on capital into a steady bleed. This is the
single input that decides whether any of this is worth running, and his
account's fee tier tells you nothing about yours.

## Deliberate divergences kept in this deployment

The local risk controls intentionally depart from the source wallet:

1. **Dynamic sizing** — 10% of near-touch bid depth is one aggregate leg
   allocation (max 20 shares), split across active rungs.
2. **Round budget** — size halves above `ROUND_SOFT_CAP` ($200) and filled
   cost plus desired resting orders cannot exceed `ROUND_HARD_CAP` ($250).
3. **Finite pair cycles** — a neutral quote set cannot expose more than
   `MAX_UNMATCHED_SHARES`; after a first-leg fill, the ahead leg is suppressed
   and only the economically capped complement is quoted.

Dashboard **Auto Balance** cancels makers and derives its FAK limit from FIFO
unmatched lots, the pair target, execution buffer, taker fee, and displayed ask
depth. If the best executable ask exceeds that cap it returns
`hedge_not_economic`, leaves the round paused, and does not turn share balance
into a deterministic loss. Process halt rails (`MAX_DAILY_LOSS`,
`MAX_OPEN_NOTIONAL`) remain separate supervisor controls.

## Backtest honesty

`PaperExchange` models queue position (median near-touch depth is 373 shares
per side against a 90-share rung, so ignoring queue would badly overstate
fills) and estimates fill volume from bid-queue shrinkage at your own level
between snapshots.

Three limits, stated plainly:

- **1-second snapshots.** Sub-second sweeps are invisible, so the
  adverse-selection bucket is under-represented and a backtest will look
  better than live.
- **Consumption vs cancellation** at a level cannot be told apart, so fills
  are somewhat over-estimated in a heavily-cancelled book.
- **Do not read PnL off this harness.** Over 633 scored rounds the real
  wallet's edge is $4.33/round with se $2.24 — **t = 1.94**. No
  few-hundred-round replay can separate a good clone from a lucky one. The
  harness exists to validate *behaviour* against `metrics.js`.

Current status on a 63-round slice: **10/10 behavioural checks pass**,
median pair cost 988.9 mils, tilt alignment 47.5%, median offset 1 tick.

## Two venue details that bite

1. **The tick is not uniform.** Polymarket uses 0.01 in the body and 0.001 in
   the tails — 425 of 78,194 sampled book levels sit off the cent grid, all
   outside 0.10–0.90. Prices are integer *mils* throughout for this reason.
2. **Public data-API timestamps are block times**, lagging the match by a
   second or two. Never measure your own fill quality with them; use the
   private fill stream.

## Live simulation and live mode

There are two intentionally separate stages:

```bash
npm test
npm run paper                 # public live book + queue-aware simulated fills
npm run live                  # real orders; requires every live safety gate
```

`paper` is the default real-data simulation. It needs no wallet or API
credentials. It runs the same engine and order manager as production, places
orders into a queue-aware `PaperExchange`, applies fills before repricing, and
tracks inventory, fees, resolution PnL and risk limits. Its fill model is an
estimate: public book shrinkage cannot distinguish trades from cancellations,
and queue position is not observable. Treat paper PnL as a calibration signal,
not evidence of profitability.

Activity logs are diagnostic evidence for mechanical behaviour such as mapping,
gates, offsets, sizing, inventory and rollover handling. Existing paper or
replay logs must not be used to conclude profitability or overall strategy
quality.

Execution role is determined by marketability, not fill speed. If placement
latency leaves a GTC buy at or above the then-current best ask, paper mode
fills it at that ask as a taker and applies the Polymarket fee curve. A quote
that successfully rests first and is subsequently consumed remains a maker
fill even when that happens quickly.

Configure paper assumptions in `.env`:

```dotenv
PAPER_FEE_BPS=0
PAPER_QUEUE_AHEAD=1
PAPER_PLACE_LATENCY_MS=600
PAPER_CANCEL_LATENCY_MS=600
PAPER_TRADE_FRACTION=0.6
DYNAMIC_SIZING=1
RUNG_DEPTH_FRACTION=0.10
MIN_RUNG_SHARES=5
MAX_RUNG_SHARES=20
MAX_LEG_SHARES=20
ROUND_SOFT_CAP=200
ROUND_HARD_CAP=250
MAX_TILT_SHARES=20
POLYMARKET_TAKER_FEE_RATE=0.07
ENTRY_GATE_SECONDS=20
PAIR_TARGET_MILS=985
PAIR_EXECUTION_BUFFER_MILS=5
PAIR_HARD_MAX_MILS=995
MAX_UNMATCHED_SHARES=10
MAX_UNMATCHED_AGE_SECONDS=60
ALLOW_NEGATIVE_PAIR_LOCK=0
PAIR_DISCOVERY_START_SECONDS=20
PAIR_ACCUMULATION_START_SECONDS=90
PAIR_ACCUMULATION_END_SECONDS=210
PAIR_COMPLETION_END_SECONDS=260
PAIR_RISK_REDUCTION_END_SECONDS=285
REPLENISH_AHEAD_LEG=0
MIN_REQUOTE_INTERVAL_MS=500
```

Dynamic sizing targets 10% of resting bid depth within two ticks per leg,
caps the aggregate leg allocation at 20 shares, and splits it across the
normal two-level post-only ladder. Filled cost plus desired resting orders
cannot exceed the hard round budget, and one-sided fills cannot exceed the
tilt budget. Marketable paper fills (placement latency walking into the ask)
use the Polymarket taker fee curve with
`POLYMARKET_TAKER_FEE_RATE` (default 0.07).

`HALTED` is terminal: the live kill switch cancelled orders and requires a
restart after investigation. In paper mode a notional breach shows
`ROUND PAUSED`; it cancels the current round only and automatically resumes
when the next round is registered.

Run paper across at least several hundred complete five-minute rounds. Use
`npm run analyse -- logs/<file>.jsonl` and the dashboard at
`http://127.0.0.1:8776`. Check that rounds are observed from open, no orders
are placed before the discovery gate, complements never exceed their displayed
cap, unmatched inventory remains bounded, and resolution produces plausible
inventory and PnL.

The dashboard shows both leg positions and averages, global pair cost, matched
and unmatched shares, completed-pair count/average/edge, both outcome PnLs,
worst-case PnL, pair regime/cycle state, complement cap, unmatched age, and
suppression reasons. HTTP clients read a pre-serialized cache and never inspect
the engine directly. **Auto balance** only locks a flat round if the resulting
worst-case settlement PnL is acceptable; resolution later does not double-count.

Recommended validation sequence: (1) unit/replay regression, (2) PAPER for
mechanical parity only, (3) LIVE shadow observation, (4) tiny LIVE maker clips
while collecting markouts, and only then (5) gradual limit increases. PAPER
does not validate profitability. Before funded validation, create a dedicated
low-balance wallet and verify its actual fee tier. Live mode requires both the
command and an explicit acknowledgement:

```bash
cp .env.example .env
# set PM_API_KEY, PM_API_SECRET, PM_API_PASSPHRASE, PM_PRIVATE_KEY, FEE_BPS
# set CONFIRM_LIVE=YES_I_ACCEPT_REAL_MONEY_RISK
npm run live
```

Start with risk limits far below your intended production values. Positions
are held to resolution; redeem CTF balances out of band.

- **join the round at t=20.** If `analyse-log.js` reports "no round joined
  from the start", every round was picked up mid-flight after a restart and
  the entry gate is untested. Run unattended across several boundaries.
- **band-gate rate.** Expect ~13% in whipsaw rounds and ~41% in one-way
  rounds. A single trend round will dominate the average; the analyser
  reports it both ways.

Cancels-per-fill (~9:1 on the target wallet) is measured from paper or live
fills, subject to the paper fill model's limitations.

### Live layer

| file | role |
|---|---|
| `src/live/feeds.js` | market + user websockets, reconnect with backoff, staleness watchdog |
| `src/live/bookState.js` | snapshot + delta application, resync detection |
| `src/live/marketResolver.js` | Gamma API window → slug / conditionId / tokenIds, with prefetch |
| `src/live/rateLimiter.js` | token bucket; **cancels always outrank places** |
| `src/live/supervisor.js` | boot resync, kill switch, round rollover, risk rails |
| `src/exchange/polymarketLive.js` | CLOB adapter with a runtime capability probe |

Uses Node's native `WebSocket` when available, with the `ws` package as
fallback (`engines.node >= 20`). `ethers` is an optional dynamic import for
on-chain PTB / resolution helpers.

### Rollover integrity

Three bugs found by a real-data run at the first round rollover, all
fixed and all with regression tests. Worth understanding, because each is
the kind that looks healthy in the logs while the bot is dead:

- **Stale sockets kept their listeners.** `subscribe()` closed the old socket
  but did not detach it, so its `close` event fired *after* the new
  subscription and marked the NEW round's books for resync. Sockets are now
  detached before closing, and every handler is generation-guarded.
- **Feed health was asserted, not observed.** `userFeedHealthy = true` was set
  synchronously at subscribe; the old socket's async close then set it back
  to false with nothing to ever restore it. The bot went permanently blind
  after one rollover — still logging, still receiving books, quoting nothing.
  Health is now driven by the socket's `connected` / `disconnected` events.
- **`reconcile()` was re-entrant.** It awaits network I/O, and at ~25 book
  messages/sec it was being re-entered before the previous pass finished.
  Observed: **28 resting orders against a maximum of 4**, a 37-deep limiter
  queue and **5.2-second cancel latency**. Reconciliation now coalesces every
  update received during network I/O to the single newest desired state and
  processes it immediately afterward. An invariant logs if live orders exceed
  `LADDER_LEVELS * 2` and escalates to `halt()`.

A fourth issue the same run exposed: books from the new round were reaching
the engine while it was still on the old round, so the new round's prices
would have been posted against the **old round's token ids**. The round slug
now travels with the book and mismatches are dropped and counted
(`staleBooksDropped` in health).

### Safety properties worth knowing

- **Boot resync.** `Supervisor.start()` cancels every pre-existing order
  before quoting a single rung. After a crash the bot has no memory of what
  it placed; anything still resting is an unknown position at an unknown
  price.
- **Live pending reconcile.** On live restart, each `logs/pending-live.json`
  row is checked against venue conditional balances
  (`getBalanceAllowance` / `getConditionalShares`). Matching share counts
  (within 0.01) resume resolution watch and may hydrate the active round;
  any mismatch or fetch error cancels, persists state, and **exits the
  process**. Do not delete pending rows until you have confirmed balances
  and redeemed out of band if needed.
- **Blind-quoting guard.** If the user (fill) websocket drops, quoting stops.
  Without fills the bot would be trading on a position it cannot see.
- **Stale-feed halt.** A socket that stays open but stops delivering is worse
  than one that closes — the bot would quote against a frozen book. The
  watchdog fires at 15s of silence.
- **Unexpected SELL halts everything.** The strategy never sells. A sell on
  this account means something else is trading it.
- **`halt()` holds positions.** It cancels orders and stops quoting; it does
  not liquidate. In **live** mode it then flushes `pending-live.json` and
  exits the process so a halted bot cannot look healthy on the dashboard.
- **Order-count invariant.** If resting orders exceed `LADDER_LEVELS * 2`,
  the order manager escalates to `halt()` (live exits).
- **UP/DOWN mapping follows the `outcomes` array, never array position.**
  Getting this backwards is the worst silent bug available here: the bot
  would look healthy, quote both legs, and report inverted inventory. It
  throws on unrecognised outcomes rather than guessing.

### Still on you

- **Verify the SDK surface.** `PolymarketLiveAdapter` probes the injected
  `@polymarket/clob-client-v2` client for `createOrder` / `postOrder` /
  `cancelOrders` / `getOpenOrders` / `getBalanceAllowance` and refuses to
  run live if any is missing. Pass `methodMap` overrides only if the SDK
  renames those exact methods.
- **Prove your fee tier.** `FEE_BPS` is operator-asserted; the fee gate does
  not query the venue. Confirm with a tiny manual trade before sizing up.
- **Redeem winning shares out of band.** Unredeemed positions sit as ERC-1155
  balances until claimed. After a live halt or mismatch exit, redeem if
  needed, reconcile `logs/pending-live.json`, then restart.

## Activity log

Every activity is written to JSONL, one event per line, in `./logs/`.

```bash
node scripts/analyse-log.js logs/activity-*.jsonl   # rebuild the checklist from your own fills
node scripts/bench-recorder.js                       # prove the overhead claim yourself
```

### Events and fields

| event | key fields |
|---|---|
| `round_open` | `rid`, `ws`, `up_token`, `dn_token` |
| `price_to_beat` | `ptb`, `ptb_src`, `poly_btc`, `bnc_btc` |
| `quote_intent` | `rungs[]`, `sup[]`, regime, pair-cycle state, complement cap |
| `order_placed` | `oid`, `leg`, `p`, `sh`, `off`, `st: resting` |
| `order_cancelled` | `oid`, `sh_left`, `age_ms`, `st: cancelled` |
| `order_rejected` | `err`, `st: rejected` |
| `fill` | role/fee plus global cost, unmatched shares, completed-pair edge and worst-case PnL |
| `MAKER_MARKOUT` | fill, future bid/mid and markout at 250/500/1000/2000/5000 ms, inventory/cycle state |
| `round_settled` | **`outcome`**, `matched`, `tilt`, `pair`, `cost_usd`, `payout_usd`, **`pnl_usd`**, `fee_usd`, `churn`, `st: settled` |
| `redeem` | `cond`, `tx`, `st: redeemed` |
| `halt` / `health` | reason plus full health snapshot |

Order lifecycle in `st`: `intent → resting → partial → filled` (or
`cancelled` / `rejected`), then `settled → redeemed`.

`quote_intent` is logged even when nothing is sent. That is what lets you
answer "why was there no rung here" after the fact — the `sup` array carries
reasons such as `pair_price_cap`, `ahead_leg`, `pair_cycle_closed`,
`late_new_cycle`, `unmatched_share_cap`, `unmatched_age`, and
`hedge_not_economic`, alongside the preserved V1 gates.

### Why it does not slow the engine

`record()` does exactly one thing: push a plain object into a fixed-size
ring. No `JSON.stringify`, no date formatting, no `fs` call, no `await`.
Serialization and writing happen in a flusher on a 250ms timer, off the hot
path. Measured on this machine:

| measurement | result |
|---|---|
| `record()` in isolation | **0.037 µs/call — 27M calls/sec** |
| full quote cycle at 100× live rate | p50 9 µs, p99 40 µs, **0 dropped**, peak ring depth 49/65536 |
| full quote cycle at 500/sec, logging on vs off | p99 delta **−2 µs** (inside noise) |
| worst case: 60k events queued at once | longest event-loop stall **6.9 ms** |

The engine sees roughly 1–2 events/sec in normal operation, so the realistic
row is the one that matters. A test asserts `record()` stays under 1 µs and
fails the build if it regresses.

Three design choices carry that result, and two of them came from the
benchmark finding real bugs:

- **The ring is bounded and drops the oldest events under pressure**, counting
  them in `dropRate`. Logging never applies backpressure to the strategy. A
  dropped log line is free; a GC pause while a rung sits stale in a moving
  market is not.
- **Flush batches are capped at 256 events.** Uncapped, a saturated ring
  produced one 65k-event `stringify` and a **71 ms** stall. Capping turned it
  into many sub-millisecond slices that yield to the event loop between each.
- **At most one early-flush callback may be pending.** Without that guard a
  full ring scheduled a `setImmediate` on *every* `record()`, queueing tens of
  thousands of callbacks — a 122 ms stall and a 73× slower `record()`. There
  is a test for it.

Set `log: { enabled: false }` on the Supervisor to swap in `NullRecorder`,
which compiles down to a no-op at every call site.

### Log volume

Measured live: the venue pushes ~9 book messages/sec **per leg**, so the
quoter runs ~25 times a second and 87.4% of consecutive intents are
byte-identical. Logging every one ran at **801 MB/day**.

`quote_intent` is therefore recorded only when the rung set or the
suppression set changes, plus a heartbeat every `INTENT_HEARTBEAT_MS`
(5s) so a quiet book still leaves a trail and "unchanged" never looks like
"crashed". A `book_snapshot` every `BOOK_SNAPSHOT_MS` (2s) covers ask-only
moves, which do not change the rung set. Net: **~107 MB/day**, with the
market still fully reconstructable from the log alone.

### Rollout order

1. Paper simulation, 24h. Confirm churn ratio, resolver miss rate, and risk limits.
2. Resolve your real fee tier; set `FEE_BPS`.
3. `npm run live` with `MIN_RUNG_SHARES=5`, `MAX_LEG_SHARES=20`, and tight
   `ROUND_HARD_CAP` / `MAX_OPEN_NOTIONAL` / `MAX_DAILY_LOSS`, one round.
4. Scale only after `metrics.js` passes on **your own** fills.
5. Redeem winning CTF balances out of band.
