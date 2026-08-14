import { EventEmitter } from 'node:events';

const GAMMA = 'https://gamma-api.polymarket.com';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/**
 * Determines which side won a round, from Polymarket directly.
 *
 * Two independent sources, because they fail differently:
 *
 *   1. Gamma API — `closed: true` plus `outcomePrices` becoming ["1","0"]
 *      or ["0","1"]. Fast, no RPC needed, but it is an indexer: it can lag
 *      the chain and it can briefly report a market closed with prices not
 *      yet final.
 *   2. On-chain CTF `payoutNumerators(conditionId, i)`. Authoritative and
 *      final, but needs a Polygon RPC and only updates once the oracle has
 *      reported.
 *
 * Default is Gamma with an on-chain confirmation when a provider is given.
 * Disagreement is treated as "not yet resolved" rather than picked between —
 * settling a round on the wrong winner corrupts every downstream metric and
 * would redeem the wrong leg.
 */
export class ResolutionWatcher extends EventEmitter {
  constructor({
    gammaBase = GAMMA,
    fetchImpl = globalThis.fetch,
    ethersProvider = null,
    pollMs = 5000,
    timeoutMs = 15 * 60 * 1000,
    requestTimeoutMs = 8000,
    logger = console,
    ethersModule = null,
  } = {}) {
    super();
    this.gammaBase = gammaBase;
    this.fetch = fetchImpl;
    this.ethersProvider = ethersProvider;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.logger = logger;
    this.ethers = ethersModule;
    this.ctf = null;
    /** @type {Map<string, {roundSlug:string, conditionId:string, since:number, nextPollAt:number}>} */
    this.pending = new Map();
    this.timer = null;
    this.polling = false;
    this.stats = { resolved: 0, timedOut: 0, disagreements: 0, errors: 0 };
  }

  /**
   * Queue a finished round. Emits `resolved` with {roundSlug, winner}.
   * `upIndex` comes from MarketResolver.parseMarket and is required for the
   * on-chain path: CTF reports payouts by outcome INDEX, and index 0 is not
   * always UP.
   */
  watch({ roundSlug, conditionId, upIndex }) {
    if (!roundSlug) return;
    if (this.pending.has(roundSlug)) return;
    const now = Date.now();
    this.pending.set(roundSlug, {
      roundSlug,
      conditionId,
      upIndex,
      since: now,
      nextPollAt: now,
    });
    this.#ensureTimer();
  }

  #ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.#poll(), this.pollMs);
    this.timer.unref?.();
  }

  async #poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.#pollOnce();
    } finally {
      this.polling = false;
    }
  }

  async #pollOnce() {
    if (!this.pending.size) {
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    for (const entry of [...this.pending.values()]) {
      const now = Date.now();
      if (entry.nextPollAt > now) continue;
      if (now - entry.since > this.timeoutMs) {
        this.stats.timedOut += 1;
        entry.since = now;
        entry.nextPollAt = now + 60_000;
        this.logger.warn?.(
          `resolution still pending for ${entry.roundSlug}; retrying in 60s`
        );
        this.emit('timeout', entry);
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const winner = await this.resolve(entry);
        if (winner) {
          this.pending.delete(entry.roundSlug);
          this.stats.resolved += 1;
          this.emit('resolved', { roundSlug: entry.roundSlug, winner, conditionId: entry.conditionId });
        }
      } catch (err) {
        this.stats.errors += 1;
        entry.nextPollAt = now + Math.max(this.pollMs, 10_000);
        this.logger.debug?.(`resolution poll failed ${entry.roundSlug}: ${err.message}`);
      }
    }
  }

  /** @returns {Promise<'UP'|'DOWN'|null>} */
  async resolve({ roundSlug, conditionId, upIndex }) {
    let gamma = null;
    try {
      gamma = await this.#fromGamma(roundSlug);
    } catch (err) {
      if (!this.ethersProvider) throw err;
      // Gamma is an indexer. An outage there must not suppress the
      // authoritative on-chain payout path when one is configured.
      this.logger.debug?.(
        `gamma resolution read failed ${roundSlug}: ${err.message}`
      );
    }
    if (!this.ethersProvider || upIndex === undefined || upIndex === null) return gamma;

    const chain = await this.#fromChain(conditionId, upIndex);
    if (!gamma && !chain) return null;
    if (gamma && chain && gamma !== chain) {
      this.stats.disagreements += 1;
      this.logger.warn?.(
        `resolution disagreement for ${roundSlug}: gamma=${gamma} chain=${chain}. ` +
          'Treating as unresolved — settling on the wrong winner would redeem the wrong leg.'
      );
      return null;
    }
    // When an on-chain provider is configured, do not realize PnL from the
    // indexer alone. Wait for the authoritative CTF payout to be reported.
    // Without a provider, Gamma is accepted only after `closed: true` and
    // exact final 1/0 outcome prices (validated in #fromGamma).
    if (!chain) return null;
    return chain;
  }

  async #fromGamma(roundSlug) {
    // The list endpoint drops these short-lived markets after they close and
    // returns []. The canonical slug endpoint retains the final 1/0 outcome.
    const res = await this.fetch(
      `${this.gammaBase}/markets/slug/${encodeURIComponent(roundSlug)}`,
      {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }
    );
    if (!res.ok) throw new Error(`gamma ${res.status}`);
    const body = await res.json();
    const market = Array.isArray(body) ? body[0] : body?.markets?.[0] ?? body;
    return ResolutionWatcher.parseGamma(market);
  }

  /**
   * `outcomePrices` is a JSON-encoded string in some Gamma versions and an
   * array in others. A resolved binary market reads exactly ["1","0"] or
   * ["0","1"]; anything else (0.98/0.02 for instance) is a live price, not a
   * resolution, and must not be treated as one.
   */
  static parseGamma(market) {
    if (!market) return null;
    if (market.closed !== true) return null;

    const parse = (v) => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
      return null;
    };
    const prices = parse(market.outcomePrices ?? market.outcome_prices);
    const outcomes = parse(market.outcomes);
    if (!prices || !outcomes || prices.length !== 2 || outcomes.length !== 2) return null;

    const nums = prices.map(Number);
    if (!nums.every((n) => Number.isFinite(n))) return null;
    const winIdx = nums.findIndex((n) => n === 1);
    const loseIdx = nums.findIndex((n) => n === 0);
    if (winIdx === -1 || loseIdx === -1) return null; // not final yet

    const label = String(outcomes[winIdx]).trim().toUpperCase();
    if (label === 'UP' || label === 'YES') return 'UP';
    if (label === 'DOWN' || label === 'NO') return 'DOWN';
    return null;
  }

  async #fromChain(conditionId, upIndex) {
    try {
      if (!this.ctf) {
        const ethers = this.ethers ?? (await import('ethers'));
        this.ctf = new ethers.Contract(
          CTF_ADDRESS,
          [
            'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
            'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
          ],
          this.ethersProvider
        );
      }
      const denom = await this.ctf.payoutDenominator(conditionId);
      if (denom === 0n) return null; // oracle has not reported
      const [n0, n1] = await Promise.all([
        this.ctf.payoutNumerators(conditionId, 0),
        this.ctf.payoutNumerators(conditionId, 1),
      ]);
      if (n0 === n1) return null; // 50/50 split, treat as unresolved
      // CTF reports by outcome INDEX. Index 0 is not always UP, so the
      // mapping must come from the market's own outcomes array.
      const winningIndex = n0 > n1 ? 0 : 1;
      return winningIndex === upIndex ? 'UP' : 'DOWN';
    } catch (err) {
      this.logger.debug?.(`chain resolution read failed: ${err.message}`);
      return null;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get queueDepth() {
    return this.pending.size;
  }
}
