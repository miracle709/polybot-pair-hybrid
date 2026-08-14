import { EventEmitter } from 'node:events';
import { sourceQuality } from './sourceQuality.js';

export class BtcReferenceFeed extends EventEmitter {
  start() {}
  stop() {}
  health() {
    return { healthy: false, reason: 'not_started' };
  }
}

/**
 * Pluggable HTTP price feed. It can be instantiated separately for BTC spot
 * momentum and for an authoritative settlement-reference stream.
 */
export class HttpBtcReferenceFeed extends BtcReferenceFeed {
  constructor({
    url,
    source,
    explicitQuality = null,
    priceField = 'price',
    publisherTimeField = 'timestamp',
    pollMs = 250,
    timeoutMs = 1000,
    fetchImpl = globalThis.fetch,
    logger = console,
  }) {
    super();
    if (!url) throw new Error('HttpBtcReferenceFeed.url required');
    if (!source) throw new Error('HttpBtcReferenceFeed.source required');
    this.url = url;
    this.source = source;
    this.explicitQuality = explicitQuality;
    this.priceField = priceField;
    this.publisherTimeField = publisherTimeField;
    this.pollMs = Math.max(50, Number(pollMs));
    this.timeoutMs = Math.max(50, Number(timeoutMs));
    this.fetch = fetchImpl;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.lastObservation = null;
    this.stats = { observations: 0, errors: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#poll();
  }

  async #poll() {
    if (!this.running) return;
    const arrivalTimeMs = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      let response;
      try {
        response = await this.fetch(this.url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const price = Number(body?.[this.priceField]);
      if (!Number.isFinite(price) || price <= 0) throw new Error('invalid price');
      const rawPublisherTime = Number(body?.[this.publisherTimeField]);
      const publisherTimeMs = Number.isFinite(rawPublisherTime)
        ? rawPublisherTime > 1e11 ? rawPublisherTime : rawPublisherTime * 1000
        : arrivalTimeMs;
      const observation = Object.freeze({
        price,
        source: this.source,
        sourceQuality: sourceQuality(this.source, this.explicitQuality),
        publisherTimeMs,
        arrivalTimeMs,
        publisherTimeDerivedFromArrival: !Number.isFinite(rawPublisherTime),
      });
      this.lastObservation = observation;
      this.stats.observations += 1;
      this.emit('price', observation);
    } catch (error) {
      this.stats.errors += 1;
      this.emit('invalid', { atMs: Date.now(), reason: error.message });
      this.logger.debug?.(`BTC reference feed: ${error.message}`);
    } finally {
      if (this.running) {
        this.timer = setTimeout(() => this.#poll(), this.pollMs);
        this.timer.unref?.();
      }
    }
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  health() {
    return {
      healthy: this.running && this.lastObservation != null,
      running: this.running,
      source: this.source,
      ageMs: this.lastObservation
        ? Math.max(0, Date.now() - this.lastObservation.publisherTimeMs)
        : null,
      ...this.stats,
    };
  }
}

export class StaticBtcReferenceFeed extends BtcReferenceFeed {
  constructor() {
    super();
    this.lastObservation = null;
  }
  push(observation) {
    this.lastObservation = Object.freeze({ ...observation });
    this.emit('price', this.lastObservation);
    return this.lastObservation;
  }
  health() {
    return { healthy: this.lastObservation != null, lastObservation: this.lastObservation };
  }
}

