import { EventEmitter } from 'node:events';
import { BookState } from './bookState.js';
import { MarketBook } from '../book.js';
import { WebSocket } from './websocket.js';

const DEFAULT_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws';

/**
 * Reconnecting websocket with exponential backoff and a staleness watchdog.
 *
 * The watchdog matters more than the reconnect. A socket that stays open but
 * stops delivering is worse than one that closes: the bot keeps quoting
 * against a frozen book while the market moves. `onStale` fires so the
 * supervisor can pull every order.
 *
 * Uses Node 22's native WebSocket — no `ws` dependency.
 */
class ReconnectingSocket extends EventEmitter {
  constructor({ url, subscribe, staleAfterMs = 15000, logger = console }) {
    super();
    this.url = url;
    this.subscribeFn = subscribe;
    this.staleAfterMs = staleAfterMs;
    this.logger = logger;
    this.ws = null;
    this.attempt = 0;
    this.lastMessageAt = 0;
    this.closed = false;
    this.watchdog = null;
    this.reconnectTimer = null;
    this.stale = false;
  }

  connect() {
    if (this.closed) return;
    this.#clearReconnectTimer();
    this.logger.info?.(`ws connecting ${this.url}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.stale = false;
      this.lastMessageAt = Date.now();
      const sub = this.subscribeFn();
      if (sub) ws.send(JSON.stringify(sub));
      this.emit('open');
      this.#startWatchdog();
    });

    ws.addEventListener('message', (ev) => {
      this.lastMessageAt = Date.now();
      if (this.stale) {
        this.stale = false;
        this.emit('fresh');
      }
      let data;
      try {
        data = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return; // venue sends bare "PONG" keepalives
      }
      for (const m of Array.isArray(data) ? data : [data]) this.emit('message', m);
    });

    ws.addEventListener('close', () => {
      this.#stopWatchdog();
      this.emit('close');
      this.#scheduleReconnect();
    });

    ws.addEventListener('error', (err) => {
      this.logger.warn?.(`ws error ${this.url}: ${err?.message ?? err}`);
    });
  }

  #startWatchdog() {
    this.#stopWatchdog();
    this.watchdog = setInterval(() => {
      // Keepalive. The venue drops idle sockets.
      try {
        if (this.ws?.readyState === 1) this.ws.send('PING');
      } catch { /* handled by close */ }
      if (Date.now() - this.lastMessageAt > this.staleAfterMs && !this.stale) {
        this.stale = true;
        this.logger.warn?.(`ws stale ${this.url} (${this.staleAfterMs}ms silent)`);
        this.emit('stale');
      }
    }, 5000);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  #stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  #clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  #scheduleReconnect() {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    this.attempt += 1;
    const backoff = Math.min(30000, 500 * 2 ** Math.min(this.attempt, 6));
    const jitter = Math.random() * 250;
    // Keep this timer referenced. Every other handle (watchdog, roll/health
    // timers, status HTTP server) is unref'd, so an unref'd reconnect after
    // book-resync close lets Node drain the event loop and exit mid-recovery.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, backoff + jitter);
  }

  close() {
    this.closed = true;
    this.#stopWatchdog();
    this.#clearReconnectTimer();
    try { this.ws?.close(); } catch { /* already gone */ }
  }

  /** Close the transport but keep this reconnecting socket active. */
  reconnect() {
    if (this.closed) return;
    // Schedule first so the ref'd timer holds the process across the close
    // gap (ws close alone would leave only unref'd handles).
    this.#scheduleReconnect();
    try {
      this.ws?.close();
    } catch {
      /* #scheduleReconnect already armed */
    }
  }
}

/**
 * Market data feed for one round's two tokens.
 *
 * Emits `book` with a MarketBook whenever either leg updates and both legs
 * are healthy. Emits `stale` / `resync` so the supervisor can flatten quotes.
 */
export class MarketFeed extends EventEmitter {
  constructor({ wsBase = DEFAULT_WS, logger = console } = {}) {
    super();
    this.wsBase = wsBase;
    this.logger = logger;
    /** @type {Map<string, BookState>} assetId -> state */
    this.states = new Map();
    /** @type {{UP:string,DOWN:string}|null} */
    this.assets = null;
    this.socket = null;
    this.generation = 0;
    this.resyncPending = false;
  }

  /** @param {{UP:string,DOWN:string}} assetIds @param {string} [roundSlug] */
  subscribe(assetIds, roundSlug = null) {
    this.assets = assetIds;
    this.roundSlug = roundSlug;
    this.states = new Map([
      [assetIds.UP, new BookState(assetIds.UP, { logger: this.logger })],
      [assetIds.DOWN, new BookState(assetIds.DOWN, { logger: this.logger })],
    ]);

    // Detach BEFORE closing. Otherwise the old socket's `close` fires
    // asynchronously — AFTER the new subscription is already live — and its
    // handler marks the NEW BookStates for resync and flattens quotes.
    // Observed in production at every round rollover.
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
    }
    this.generation += 1;
    this.resyncPending = false;
    const gen = this.generation;
    this.socket = new ReconnectingSocket({
      url: `${this.wsBase}/market`,
      subscribe: () => ({ type: 'market', assets_ids: [assetIds.UP, assetIds.DOWN] }),
      logger: this.logger,
    });

    // Every handler is generation-guarded as a second line of defence: even
    // if a listener survives, it cannot act on behalf of a stale round.
    this.socket.on('message', (m) => {
      if (gen === this.generation) this.#onMessage(m);
    });
    this.socket.on('stale', () => {
      if (gen === this.generation) this.emit('stale');
    });
    this.socket.on('close', () => {
      if (gen !== this.generation) return;
      // Deltas across a disconnect are lost by definition.
      if (!this.resyncPending) {
        this.resyncPending = true;
        for (const st of this.states.values()) st.markResync('socket closed');
        this.emit('resync');
      }
    });
    this.socket.connect();
  }

  #onMessage(m) {
    const type = m.event_type ?? m.type;
    // Current CLOB price_change messages are commonly batched. Their
    // top-level `market` is the condition id, while each change carries its
    // own token asset_id. Routing only by the top-level field silently
    // discarded every delta and froze both displayed prices.
    if (type === 'price_change') {
      const changes =
        m.changes ??
        m.price_changes ??
        (m.price !== undefined ? [m] : null);
      if (!Array.isArray(changes)) return;
      const byAsset = new Map();
      for (const change of changes) {
        const id =
          change.asset_id ??
          change.assetId ??
          m.asset_id ??
          m.assetId;
        if (!this.states.has(id)) continue;
        if (!byAsset.has(id)) byAsset.set(id, []);
        byAsset.get(id).push(change);
      }
      for (const [id, tokenChanges] of byAsset) {
        this.states.get(id).applyDelta({
          ...m,
          changes: tokenChanges,
        });
      }
      if (byAsset.size) this.#publish();
      return;
    }

    const assetId = m.asset_id ?? m.assetId;
    const state = this.states.get(assetId);

    if (type === 'book' && state) {
      state.applySnapshot(m);
    } else if (type === 'tick_size_change') {
      // Prices are stored in mils, so both tick regimes coexist. Nothing to
      // rescale — but resync anyway: the level set changes shape.
      state?.markResync('tick size change');
      this.emit('resync');
      return;
    } else {
      return; // last_trade_price and friends: not needed by the strategy
    }
    this.#publish();
  }

  #publish() {
    if (!this.assets) return;
    const up = this.states.get(this.assets.UP)?.toLegBook();
    const down = this.states.get(this.assets.DOWN)?.toLegBook();
    if (!up || !down) {
      if ([...this.states.values()].some((state) => state.needsResync)) {
        this.#requestResync('invalid reconstructed book');
      }
      return;
    }
    // Recovery is complete only when snapshots for BOTH tokens are usable.
    // Clearing this at socket-open would let the first token snapshot trigger
    // another reconnect while the second snapshot is still in flight.
    this.resyncPending = false;
    // The round slug travels WITH the book. Without it the supervisor cannot
    // tell that a book from the new round arrived while the engine is still
    // on the old one — which in live trading means posting the new round's
    // prices against the old round's token ids.
    this.emit('book', new MarketBook(up, down), Math.max(up.ts, down.ts), this.roundSlug);
  }

  #requestResync(reason) {
    if (this.resyncPending) return;
    this.resyncPending = true;
    for (const state of this.states.values()) state.markResync(reason);
    this.emit('resync');
    this.socket?.reconnect();
  }

  health() {
    return [...this.states.values()].map((s) => ({
      assetId: s.assetId,
      ready: s.ready,
      needsResync: s.needsResync,
      ...s.stats,
    }));
  }

  close() {
    // Detach first: a deliberate shutdown must not fire resync handlers.
    this.socket?.removeAllListeners();
    this.socket?.close();
  }
}

/**
 * Private fill feed.
 *
 * Without this the bot quotes blind: inventory never updates, so the
 * lagging-leg bias never engages and the pair-cost and tilt guards read
 * zero forever. Treat a dead user socket as a reason to stop quoting, not
 * as a degraded mode.
 */
export class UserFeed extends EventEmitter {
  constructor({ wsBase = DEFAULT_WS, apiCreds, logger = console }) {
    super();
    this.wsBase = wsBase;
    this.apiCreds = apiCreds;
    this.logger = logger;
    this.socket = null;
    this.generation = 0;
    /** @type {Map<string,'UP'|'DOWN'>} assetId -> leg, set per round */
    this.legByAsset = new Map();
    this.roundByAsset = new Map();
    this.assetsByRound = new Map();
    this.seenFillIds = new Set();
    this.fillStatusById = new Map();
    this.isOwnOrder = () => false;
  }

  setOrderLookup(isOwnOrder) {
    this.isOwnOrder =
      typeof isOwnOrder === 'function'
        ? isOwnOrder
        : () => false;
  }

  setRoundAssets(assetIds, roundSlug = null) {
    this.legByAsset.set(assetIds.UP, 'UP');
    this.legByAsset.set(assetIds.DOWN, 'DOWN');
    if (roundSlug) {
      this.roundByAsset.set(assetIds.UP, roundSlug);
      this.roundByAsset.set(assetIds.DOWN, roundSlug);
      this.assetsByRound.set(roundSlug, [assetIds.UP, assetIds.DOWN]);
      // Retain a short tail for fills matched during rollover and delivered
      // after the new subscription becomes active.
      while (this.assetsByRound.size > 4) {
        const [oldRound, oldAssets] = this.assetsByRound.entries().next().value;
        this.assetsByRound.delete(oldRound);
        for (const asset of oldAssets) {
          this.legByAsset.delete(asset);
          this.roundByAsset.delete(asset);
        }
      }
    }
  }

  subscribe(markets) {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
    }
    this.generation += 1;
    const gen = this.generation;
    this.socket = new ReconnectingSocket({
      url: `${this.wsBase}/user`,
      subscribe: () => ({
        type: 'user',
        markets,
        auth: {
          apiKey: this.apiCreds.key,
          secret: this.apiCreds.secret,
          passphrase: this.apiCreds.passphrase,
        },
      }),
      logger: this.logger,
    });
    this.socket.on('message', (m) => {
      if (gen === this.generation) this.#onMessage(m);
    });
    this.socket.on('stale', () => {
      if (gen === this.generation) this.emit('stale');
    });
    // Health must be DRIVEN by the socket, not asserted optimistically at
    // subscribe time. The previous code set healthy=true synchronously and
    // the old socket's async close immediately set it back to false, leaving
    // the bot permanently blind with no way to recover.
    this.socket.on('open', () => {
      if (gen === this.generation) this.emit('connected');
    });
    this.socket.on('close', () => {
      if (gen === this.generation) this.emit('disconnected');
    });
    this.socket.connect();
  }

  #onMessage(m) {
    const body =
      m?.payload && typeof m.payload === 'object'
        ? m.payload
        : m;
    const type =
      body.event_type ??
      body.eventType ??
      body.type ??
      m.event_type ??
      m.eventType ??
      m.type;
    if (type !== 'trade' && type !== 'fill') return;
    const explicitRole = String(
      body.trader_side ?? body.traderSide ?? body.role ?? ''
    ).toUpperCase() || null;
    const makerOrders = Array.isArray(body.maker_orders)
      ? body.maker_orders
      : Array.isArray(body.makerOrders)
        ? body.makerOrders
        : [];
    const apiKey = String(this.apiCreds?.key ?? '');
    const ownedMakerOrders = makerOrders.filter((order) => {
      const orderId = order.order_id ?? order.orderId;
      const owner = order.owner ?? order.orderOwner;
      return (
        (orderId && this.isOwnOrder(String(orderId))) ||
        (apiKey && String(owner ?? '') === apiKey)
      );
    });
    // Some compatibility wrappers omit traderSide. An owned maker order is
    // unambiguous; otherwise the authenticated account is the taker and the
    // top-level size/price are its fill.
    const role =
      explicitRole ??
      (ownedMakerOrders.length ? 'MAKER' : 'TAKER');
    let participants = [null];
    if (role === 'MAKER') {
      if (ownedMakerOrders.length) {
        participants = ownedMakerOrders;
      } else if (makerOrders.length === 1) {
        // Older events sometimes omit account attribution but contain only
        // the authenticated maker's one matched order.
        participants = makerOrders;
      } else {
        // The aggregate taker size can span several makers. Counting it as
        // ours would inflate shares and corrupt every later PnL value.
        this.emit('ambiguous_fill', {
          tradeId: body.id ?? body.trade_id ?? body.tradeId ?? null,
          makerOrderCount: makerOrders.length,
          roundSlug: makerOrders
            .map((order) =>
              String(
                order.asset_id ??
                order.assetId ??
                order.token_id ??
                order.tokenId ??
                ''
              )
            )
            .map((assetId) => this.roundByAsset.get(assetId))
            .find(Boolean) ?? null,
          raw: body,
        });
        return;
      }
    }

    const rawTime =
      body.matchedAt ??
      body.matchTime ??
      body.matchtime ??
      body.match_time ??
      body.timestamp ??
      Date.now() / 1000;
    const numericTime = Number(rawTime);
    const parsedTime = Date.parse(rawTime);
    const ts = Number.isFinite(numericTime)
      ? numericTime > 1e11
        ? numericTime / 1000
        : numericTime
      : Number.isFinite(parsedTime)
        ? parsedTime / 1000
        : Date.now() / 1000;

    const tradeId =
      body.id ??
      body.trade_id ??
      body.tradeId ??
      null;
    const status = String(body.status ?? '')
      .toUpperCase()
      .replace(/^TRADE_STATUS_/, '');
    for (let i = 0; i < participants.length; i += 1) {
      const participant = participants[i];
      const assetIdRaw =
        participant?.asset_id ??
        participant?.assetId ??
        participant?.token_id ??
        participant?.tokenId ??
        body.asset_id ??
        body.assetId ??
        body.token_id ??
        body.tokenId;
      if (assetIdRaw === undefined || assetIdRaw === null) continue;
      const assetId = String(assetIdRaw);
      const leg = this.legByAsset.get(assetId);
      if (!leg) continue; // unrelated account/round activity

      const side = String(participant?.side ?? body.side ?? 'BUY').toUpperCase();
      if (side === 'SELL') {
        // The strategy never sells. For maker trades this is the matched
        // maker order's side, not the taker's side.
        this.emit('unexpected_sell', participant ?? body);
        continue;
      }

      const price = Number(participant?.price ?? body.price);
      const size = Number(
        participant?.matched_amount ??
        participant?.matchedAmount ??
        body.size ??
        body.matched_amount ??
        body.matchedAmount
      );
      if (
        !Number.isFinite(price) ||
        price <= 0 ||
        price >= 1 ||
        !Number.isFinite(size) ||
        size <= 0
      ) continue;

      const orderId =
        participant?.order_id ??
        participant?.orderId ??
        body.order_id ??
        body.orderId ??
        body.taker_order_id ??
        body.takerOrderId ??
        body.maker_order_id ??
        body.makerOrderId ??
        null;
      const fillId =
        `${tradeId ?? `${assetId}:${body.timestamp ?? rawTime}`}:` +
        `${orderId ?? i}`;
      const roundSlug = this.roundByAsset.get(assetId) ?? null;
      const priorStatus = this.fillStatusById.get(fillId) ?? null;
      if (status === 'FAILED') {
        if (priorStatus === 'FAILED') continue;
        this.#rememberFill(fillId, status, false);
        this.emit('fill_failed', {
          fillId,
          tradeId,
          orderId,
          roundSlug,
          wasBooked: this.seenFillIds.has(fillId),
          priorStatus,
          raw: body,
        });
        continue;
      }
      if (priorStatus === 'FAILED') continue;
      if (status === 'RETRYING') {
        // Wait for a later MINED/CONFIRMED update. If MATCHED was already
        // booked, keep it provisional and let FAILED trigger reconciliation.
        this.#rememberFill(
          fillId,
          status,
          this.seenFillIds.has(fillId)
        );
        continue;
      }
      if (this.seenFillIds.has(fillId)) {
        this.#rememberFill(fillId, status || priorStatus, true);
        continue;
      }

      const feeRateRaw =
        participant?.fee_rate_bps ??
        participant?.feeRateBps ??
        body.fee_rate_bps ??
        body.feeRateBps;
      const feeRateBps =
        feeRateRaw === '' ||
        feeRateRaw === null ||
        feeRateRaw === undefined
          ? Number.NaN
          : Number(feeRateRaw);
      const reportedFee = Number(
        participant?.fee ??
        participant?.fee_usdc ??
        participant?.feeUsd ??
        body.fee ??
        body.fee_usdc ??
        body.feeUsd
      );
      let fee = 0;
      if (role !== 'MAKER') {
        if (Number.isFinite(reportedFee) && reportedFee >= 0) {
          fee = reportedFee;
        } else if (role === 'TAKER' && Number.isFinite(feeRateBps)) {
          fee =
            Math.round(
              size *
                (feeRateBps / 10_000) *
                price *
                (1 - price) *
                1e5
            ) / 1e5;
        }
      }
      this.#rememberFill(fillId, status || 'MATCHED', true);

      this.emit('fill', {
        leg,
        roundSlug,
        price,
        size,
        role,
        fee,
        feeRateBps: Number.isFinite(feeRateBps) ? feeRateBps : null,
        status: body.status ?? null,
        transactionHash:
          body.transaction_hash ?? body.transactionHash ?? null,
        // Use the venue's match time if present. NEVER use public data-API
        // timestamps here: those are block times and lag the match by 1-2s.
        ts,
        orderId,
        full: String(
          body.fill_status ?? body.fillStatus ?? ''
        ).toUpperCase() === 'FULL',
        raw: body,
      });
    }
  }

  #rememberFill(fillId, status, booked) {
    this.fillStatusById.set(fillId, status);
    if (booked) this.seenFillIds.add(fillId);
    while (this.fillStatusById.size > 20000) {
      const oldest = this.fillStatusById.keys().next().value;
      this.fillStatusById.delete(oldest);
      this.seenFillIds.delete(oldest);
    }
  }

  close() {
    this.socket?.removeAllListeners();
    this.socket?.close();
  }
}
