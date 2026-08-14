const GAMMA = 'https://gamma-api.polymarket.com';

/**
 * Resolves a 5-minute window to its market: slug, condition id, and the two
 * token ids.
 *
 * Timing matters. A round is 300 seconds and the bot's entry gate is at
 * the entry gate, so resolution has a short startup budget — but a cold HTTP call at t=0
 * competes with the market open, which is the busiest moment on the venue.
 * This resolver PREFETCHES the next round while the current one is still
 * running, so t=0 is a cache hit.
 *
 * A miss is not fatal: the bot simply does not quote that round. He traded
 * 1,473 of a possible 1,489 windows (98.9%), so a ~1% miss rate is normal
 * and not worth taking risks to avoid.
 */
export class MarketResolver {
  constructor({
    gammaBase = GAMMA,
    slugPrefix = 'btc-updown-5m-',
    roundSeconds = 300,
    logger = console,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.gammaBase = gammaBase;
    this.slugPrefix = slugPrefix;
    this.roundSeconds = roundSeconds;
    this.logger = logger;
    this.fetch = fetchImpl;
    /** @type {Map<number, Promise<any>>} windowStart -> resolution */
    this.cache = new Map();
  }

  slugFor(windowStart) {
    return `${this.slugPrefix}${windowStart}`;
  }

  /**
   * @returns {Promise<{roundSlug:string, conditionId:string, tokenIds:{UP:string,DOWN:string}}>}
   */
  async resolve(windowStart) {
    if (!this.cache.has(windowStart)) {
      const request = this.#fetchMarket(windowStart).catch((err) => {
        // A just-opened 5-minute market can briefly be absent from Gamma.
        // Never cache that rejection for the whole round; Supervisor retries
        // the same window on its next one-second rollover check.
        if (this.cache.get(windowStart) === request) {
          this.cache.delete(windowStart);
        }
        throw err;
      });
      this.cache.set(windowStart, request);
    }
    // Keep the cache from growing forever across a long session.
    for (const k of this.cache.keys()) {
      if (k < windowStart - 4 * this.roundSeconds) this.cache.delete(k);
    }
    return this.cache.get(windowStart);
  }

  /** Warm the next window's entry while the current round is mid-flight. */
  prefetchNext(windowStart) {
    const next = windowStart + this.roundSeconds;
    if (!this.cache.has(next)) {
      this.cache.set(
        next,
        this.#fetchMarket(next).catch((err) => {
          // Prefetch failure must not reject an unhandled promise; drop it
          // so resolve() can retry cleanly at round open.
          this.cache.delete(next);
          this.logger.debug?.(`prefetch ${next} failed: ${err.message}`);
          return null;
        })
      );
    }
  }

  async #fetchMarket(windowStart) {
    const slug = this.slugFor(windowStart);
    const url = `${this.gammaBase}/markets?slug=${encodeURIComponent(slug)}`;
    const res = await this.fetch(url, { headers: { accept: 'application/json' } });
    const serverDateMs = Date.parse(res.headers?.get?.('date') ?? '');
    if (Number.isFinite(serverDateMs)) {
      this.lastServerEpochSeconds = serverDateMs / 1000;
    }
    if (!res.ok) throw new Error(`gamma ${res.status} for ${slug}`);
    const body = await res.json();
    const market = Array.isArray(body) ? body[0] : body?.markets?.[0] ?? body;
    if (!market) throw new Error(`no market for ${slug}`);
    const returnedSlug = market.slug ?? market.market_slug ?? null;
    if (returnedSlug && String(returnedSlug) !== slug) {
      throw new Error(
        `gamma returned ${returnedSlug} while resolving ${slug}`
      );
    }
    return MarketResolver.parseMarket(market, slug);
  }

  /**
   * Gamma returns `clobTokenIds` and `outcomes` as JSON-encoded STRINGS in
   * some versions and arrays in others. Both are handled; anything else
   * throws rather than guessing which token is UP.
   *
   * Getting UP and DOWN backwards is the single worst silent bug available
   * here: the bot would still look healthy, quote both legs, and build a
   * perfectly hedged position while reporting inverted inventory.
   */
  static parseMarket(market, slug) {
    const parseMaybeJson = (v) => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return null;
    };

    const tokens = parseMaybeJson(market.clobTokenIds ?? market.clob_token_ids);
    const outcomes = parseMaybeJson(market.outcomes);
    if (!tokens || tokens.length !== 2 || !outcomes || outcomes.length !== 2) {
      throw new Error(`cannot parse tokens/outcomes for ${slug}`);
    }

    const idx = {};
    outcomes.forEach((o, i) => {
      const k = String(o).trim().toUpperCase();
      if (k === 'UP' || k === 'YES') idx.UP = i;
      if (k === 'DOWN' || k === 'NO') idx.DOWN = i;
    });
    if (idx.UP === undefined || idx.DOWN === undefined) {
      throw new Error(`unrecognised outcomes ${JSON.stringify(outcomes)} for ${slug}`);
    }

    return {
      roundSlug: slug,
      conditionId: market.conditionId ?? market.condition_id,
      negRiskMarketId: market.negRiskMarketID ?? market.neg_risk_market_id ?? null,
      tokenIds: { UP: String(tokens[idx.UP]), DOWN: String(tokens[idx.DOWN]) },
      // Needed by the on-chain resolution path: CTF payouts are indexed by
      // position in `outcomes`, and UP is not reliably index 0.
      upIndex: idx.UP,
      downIndex: idx.DOWN,
      outcomes,
      closed: Boolean(market.closed),
    };
  }
}
