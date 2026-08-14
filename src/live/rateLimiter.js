/**
 * Token-bucket rate limiter for order operations.
 *
 * This is the component most likely to decide whether the bot survives
 * contact with the venue. The strategy reprices on every book change:
 * ~108 one-tick mid moves per round x 2 legs x 2 ladder levels, with ~90%
 * of postings cancelled unfilled. That is a few hundred order operations
 * per 5-minute round, on the order of 50-80k/day.
 *
 * Polymarket publishes per-endpoint limits that change. Do not trust the
 * defaults here; use conservative live limits and monitor them. The failure
 * mode if you get this wrong is not a clean 429: it is a
 * cancel that does not land, leaving a stale rung resting in a fast market.
 * That is exactly the -22.3% ROI bucket the reconstruction found.
 */
export class RateLimiter {
  /**
   * @param {Object} opts
   * @param {number} opts.capacity   burst size
   * @param {number} opts.refillPerSec  sustained rate
   * @param {number} [opts.maxQueue] reject beyond this many waiters
   */
  constructor({ capacity, refillPerSec, maxQueue = 500, logger = console }) {
    if (!(capacity > 0) || !(refillPerSec > 0)) {
      throw new RangeError('RateLimiter: capacity and refillPerSec must be > 0');
    }
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.maxQueue = maxQueue;
    this.logger = logger;
    this.tokens = capacity;
    this.last = Date.now();
    /** @type {Array<{resolve:Function,reject:Function,cost:number,priority:number,enqueuedAt:number}>} */
    this.queue = [];
    this.stats = { granted: 0, rejected: 0, maxWaitMs: 0, maxQueueDepth: 0 };
    this.timer = null;
  }

  #refill() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
  }

  /**
   * @param {number} cost tokens consumed
   * @param {number} priority lower runs first. Cancels MUST outrank places:
   *   a queued cancel behind a burst of places is a stale order in a
   *   moving market.
   */
  acquire(cost = 1, priority = 1) {
    this.#refill();
    if (this.queue.length === 0 && this.tokens >= cost) {
      this.tokens -= cost;
      this.stats.granted += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      this.stats.rejected += 1;
      return Promise.reject(new Error('RateLimiter: queue full, shedding load'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, cost, priority, enqueuedAt: Date.now() });
      this.queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
      this.stats.maxQueueDepth = Math.max(this.stats.maxQueueDepth, this.queue.length);
      this.#schedule();
    });
  }

  #schedule() {
    if (this.timer) return;
    const tick = () => {
      this.timer = null;
      this.#refill();
      while (this.queue.length && this.tokens >= this.queue[0].cost) {
        const item = this.queue.shift();
        this.tokens -= item.cost;
        this.stats.granted += 1;
        this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, Date.now() - item.enqueuedAt);
        item.resolve();
      }
      if (this.queue.length) {
        const need = this.queue[0].cost - this.tokens;
        const waitMs = Math.max(10, (need / this.refillPerSec) * 1000);
        this.timer = setTimeout(tick, waitMs);
      }
    };
    // Deliberately NOT unref'd: a pending timer here means queued order
    // operations. Letting the process exit with cancels still queued is how
    // you leave rungs resting in a live market.
    this.timer = setTimeout(tick, 10);
  }

  /** Fraction of burst capacity currently consumed. */
  get utilisation() {
    this.#refill();
    return 1 - this.tokens / this.capacity;
  }

  drainAndReject(reason) {
    for (const item of this.queue) item.reject(new Error(reason));
    this.queue = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Priorities. Cancels always jump the queue. */
export const PRIORITY = { CANCEL: 0, PLACE: 1 };
