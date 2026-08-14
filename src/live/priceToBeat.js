import { EventEmitter } from 'node:events';

/**
 * The Chainlink open that a round settles against.
 *
 * The CLOB does not publish this on any channel, so it has to come from
 * somewhere else. Three sources, in descending order of how much you should
 * trust them:
 *
 *   1. Your own tracker, if it already captures `price_to_beat` alongside
 *      `price_to_beat_source` — this is the same number the market resolves
 *      against, and it is what the historical analysis used.
 *   2. The Chainlink aggregator read directly on-chain.
 *   3. A spot print from an exchange — DO NOT do this. Binance and the
 *      Chainlink open differ by roughly $60 in the captured data, and the
 *      whole round hinges on which side of the strike you land.
 *
 * Every provider emits `{ptb, src, poly, binance, sec}` and the `src` field
 * is mandatory, precisely so a spot print can never be silently mistaken for
 * the strike downstream.
 */
export class PriceToBeatProvider extends EventEmitter {
  /** @param {string} roundSlug @param {number} windowStart */
  // eslint-disable-next-line no-unused-vars
  async fetchFor(roundSlug, windowStart) {
    throw new Error('not implemented');
  }
  stop() {}
}

/**
 * Polls an HTTP endpoint that serves your tracker's TICK shape:
 *
 *   { round_slug, seconds_into_round, price_to_beat, price_to_beat_source,
 *     polymarket_btc_usd, binance_btc_usd }
 *
 * This is exactly the shape of `latest_state.json`, so if your tracker
 * already writes that file over HTTP you are done.
 *
 * Polls until it sees a value for the round it was asked about — the strike
 * appears within 1-2 seconds of round open, well inside the entry gate.
 */
export class HttpPriceToBeatProvider extends PriceToBeatProvider {
  constructor({
    url,
    pollMs = 1000,
    timeoutMs = 12000,
    logger = console,
    fetchImpl = globalThis.fetch,
  }) {
    super();
    if (!url) throw new Error('HttpPriceToBeatProvider: url required');
    this.url = url;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.timer = null;
    this.stats = { hits: 0, misses: 0, errors: 0 };
  }

  async fetchFor(roundSlug) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await this.fetch(this.url, { headers: { accept: 'application/json' } });
        if (res.ok) {
          const d = await res.json();
          const parsed = HttpPriceToBeatProvider.parse(d, roundSlug);
          if (parsed) {
            this.stats.hits += 1;
            this.emit('price_to_beat', parsed);
            return parsed;
          }
        }
      } catch (err) {
        this.stats.errors += 1;
        this.logger.debug?.(`ptb poll error: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    this.stats.misses += 1;
    // A miss is not fatal. The strike is logged for analysis; the strategy
    // does not read it, because the target wallet does not either.
    this.logger.warn?.(`no price_to_beat for ${roundSlug} within ${this.timeoutMs}ms`);
    return null;
  }

  /** Returns null if the payload is for a different round or has no strike. */
  static parse(d, roundSlug) {
    if (!d || typeof d !== 'object') return null;
    if (roundSlug && d.round_slug && d.round_slug !== roundSlug) return null;
    const ptb = Number(d.price_to_beat);
    if (!Number.isFinite(ptb) || ptb <= 0) return null;
    return {
      ptb,
      src: d.price_to_beat_source ?? 'unknown',
      poly: Number.isFinite(Number(d.polymarket_btc_usd)) ? Number(d.polymarket_btc_usd) : null,
      binance: Number.isFinite(Number(d.binance_btc_usd)) ? Number(d.binance_btc_usd) : null,
      sec: Number.isFinite(Number(d.seconds_into_round)) ? Number(d.seconds_into_round) : null,
    };
  }
}

/**
 * Reads the Chainlink BTC/USD aggregator on Polygon directly.
 *
 * Use when you have no tracker of your own. Reads the CURRENT answer, so it
 * must be called promptly at round open — before the entry gate it is a good
 * proxy for the open; at t=200 it is just spot.
 *
 * IMPORTANT — this is NOT the feed the market resolves against. Polymarket
 * lists `https://data.chain.link/streams/btc-usd` as the resolution source,
 * which is Chainlink DATA STREAMS (low-latency, pull-based, credentialed).
 * This class reads the on-chain Data FEED aggregator, which updates on a
 * deviation threshold or heartbeat and can therefore sit stale by dollars at
 * 5-minute granularity. Good enough to log and analyse; do not treat it as
 * the settlement price, and do not compute "did we win" from it. The `src`
 * field says `chainlink_onchain_approx` for exactly this reason.
 *
 * Polygon BTC/USD aggregator: 0xc907E116054Ad103354f2D350FD2514433D57F6f
 */
export class ChainlinkPriceToBeatProvider extends PriceToBeatProvider {
  constructor({
    provider,
    feed = '0xc907E116054Ad103354f2D350FD2514433D57F6f',
    logger = console,
    ethersModule = null,
  }) {
    super();
    this.provider = provider;
    this.feed = feed;
    this.logger = logger;
    this.ethers = ethersModule;
    this.contract = null;
  }

  async #instance() {
    if (this.contract) return this.contract;
    const ethers = this.ethers ?? (await import('ethers'));
    this.contract = new ethers.Contract(
      this.feed,
      [
        'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
        'function decimals() view returns (uint8)',
      ],
      this.provider
    );
    this.decimals = Number(await this.contract.decimals());
    return this.contract;
  }

  async fetchFor(roundSlug) {
    try {
      const c = await this.#instance();
      const [, answer, , updatedAt] = await c.latestRoundData();
      const ptb = Number(answer) / 10 ** this.decimals;
      const out = {
        ptb,
        src: 'chainlink_onchain_approx',
        poly: null,
        binance: null,
        sec: null,
        updatedAt: Number(updatedAt),
      };
      this.emit('price_to_beat', out);
      return out;
    } catch (err) {
      this.logger.warn?.(`chainlink read failed for ${roundSlug}: ${err.message}`);
      return null;
    }
  }
}

/**
 * Reads a local JSON file that your tracker keeps up to date — typically
 * `latest_state.json`.
 *
 * This is the simplest option when the tracker runs on the same machine as
 * the bot: no HTTP hop, no extra service, and the file is already being
 * written. Reads are async and the result is fired without await, so a
 * missing or half-written file can never delay quoting.
 */
export class FilePriceToBeatProvider extends PriceToBeatProvider {
  constructor({ path, pollMs = 1000, timeoutMs = 12000, logger = console, fsModule = null }) {
    super();
    if (!path) throw new Error('FilePriceToBeatProvider: path required');
    this.path = path;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.fs = fsModule;
    this.stats = { hits: 0, misses: 0, errors: 0 };
  }

  async fetchFor(roundSlug) {
    const fs = this.fs ?? (await import('node:fs/promises'));
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      try {
        const raw = await fs.readFile(this.path, 'utf8');
        // A tracker rewriting the file can be caught mid-write; a parse
        // failure is expected occasionally and simply means "try again".
        const parsed = HttpPriceToBeatProvider.parse(JSON.parse(raw), roundSlug);
        if (parsed) {
          this.stats.hits += 1;
          this.emit('price_to_beat', parsed);
          return parsed;
        }
      } catch (err) {
        this.stats.errors += 1;
        this.logger.debug?.(`ptb file read: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    this.stats.misses += 1;
    this.logger.warn?.(`no price_to_beat for ${roundSlug} in ${this.path}`);
    return null;
  }
}

/**
 * Reads the strike from Polymarket's own market metadata.
 *
 * CONFIRMED (2026-07-27, live discovery against btc-updown-5m): Gamma does
 * NOT publish the strike for these markets. The only BTC-range numbers on the
 * object are liquidity and volume; the question is just a time range
 * ("Bitcoin Up or Down - July 27, 2:50PM-2:55PM ET") and the description
 * points at Chainlink as the resolution source.
 *
 * This class is therefore kept only for the case where Polymarket starts
 * publishing it, or for other market families that do. It defaults to
 * `parseText: false` because the useful text simply is not there, and a
 * loose regex over slugs and descriptions invents numbers — the discovery
 * script's own text scan produced "178517" from the epoch in the slug.
 *
 * For btc-updown-5m, use ChainlinkPriceToBeatProvider instead.
 */
export class GammaPriceToBeatProvider extends PriceToBeatProvider {
  static CANDIDATE_FIELDS = [
    'strikePrice', 'strike_price', 'strike',
    'openPrice', 'open_price', 'startPrice', 'start_price',
    'settlementPrice', 'referencePrice', 'initialPrice',
  ];

  constructor({
    gammaBase = 'https://gamma-api.polymarket.com',
    field = null,
    parseText = false,
    logger = console,
    fetchImpl = globalThis.fetch,
  } = {}) {
    super();
    this.gammaBase = gammaBase;
    this.field = field;
    this.parseText = parseText;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.reportedMiss = false;
  }

  async fetchFor(roundSlug) {
    try {
      const res = await this.fetch(`${this.gammaBase}/markets?slug=${encodeURIComponent(roundSlug)}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const body = await res.json();
      const market = Array.isArray(body) ? body[0] : body?.markets?.[0] ?? body;
      const out = GammaPriceToBeatProvider.extract(market, {
        field: this.field,
        parseText: this.parseText,
      });
      if (out) {
        this.emit('price_to_beat', out);
        return out;
      }
      if (!this.reportedMiss) {
        this.reportedMiss = true;
        this.logger.warn?.(
          'Gamma does not publish a strike for these markets (confirmed by ' +
            'discovery). Set POLYGON_RPC and PTB_SOURCE=chainlink, or point ' +
            'PTB_FILE at your own tracker. Nothing trades on the strike, so ' +
            'this is a logging gap, not a trading fault.'
        );
      }
      return null;
    } catch (err) {
      this.logger.debug?.(`gamma strike read failed: ${err.message}`);
      return null;
    }
  }

  /** Exposed for testing against a captured market object. */
  static extract(market, { field = null, parseText = true } = {}) {
    if (!market) return null;
    const sane = (n) => Number.isFinite(n) && n > 10000 && n < 1000000;

    const tryField = (k) => {
      const v = market[k];
      const n = typeof v === 'string' ? Number(v) : v;
      return sane(n) ? { ptb: n, src: `gamma:${k}` } : null;
    };

    if (field) return tryField(field);

    for (const k of GammaPriceToBeatProvider.CANDIDATE_FIELDS) {
      const hit = tryField(k);
      if (hit) return { ...hit, poly: null, binance: null, sec: null };
    }

    if (parseText) {
      // These questions read like: "Bitcoin Up or Down - ... above $65,159.58?"
      for (const k of ['question', 'description', 'title', 'groupItemTitle']) {
        const text = market[k];
        if (typeof text !== 'string') continue;
        const m = text.match(/\$\s?(\d{2,3}[,\s]?\d{3}(?:\.\d+)?)/);
        if (!m) continue;
        const n = Number(m[1].replace(/[,\s]/g, ''));
        if (sane(n)) return { ptb: n, src: `gamma:${k}:text`, poly: null, binance: null, sec: null };
      }
    }
    return null;
  }
}

/** For tests and for feeding a value you already have in hand. */
export class StaticPriceToBeatProvider extends PriceToBeatProvider {
  constructor(value) {
    super();
    this.value = value;
  }
  async fetchFor() {
    return this.value;
  }
}
