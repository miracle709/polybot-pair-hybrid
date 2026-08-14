import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Monitoring server with one operator action (auto-balance).
 *
 * Browser status polls never inspect the engine. A low-frequency timer takes
 * one bounded snapshot and serializes it in advance; GET handlers only write
 * cached bytes. Opening ten dashboards therefore costs the strategy no more
 * than opening none. POST /api/auto-balance is the sole write path.
 */
export class StatusServer {
  constructor({
    supervisor,
    port = 8776,
    host = '127.0.0.1',
    token = null,
    logger = console,
    snapshotMs = 250,
    ordersSnapshotMs = 1000,
  }) {
    this.supervisor = supervisor;
    this.port = port;
    this.host = host;
    this.token = token;
    this.logger = logger;
    this.snapshotMs = Math.max(250, snapshotMs);
    this.server = null;
    this.snapshotTimer = null;
    this.lastBuildMs = 0;
    this.maxBuildMs = 0;
    this.snapshotFailures = 0;
    this.lastSnapshotAt = 0;
    this.cached = new Map();
    this.cachedOrders = [];
    this.ordersRound = null;
    this.ordersVersion = Symbol('unbuilt');
    this.lastOrdersBuildAt = 0;
    this.ordersSnapshotMs = Math.max(this.snapshotMs, ordersSnapshotMs);
    this.dashboard = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'));
    this.#refresh();
  }

  start() {
    if (this.server) return this.server;
    this.snapshotTimer = setInterval(() => this.#refresh(), this.snapshotMs);
    this.snapshotTimer.unref?.();
    this.server = http.createServer((req, res) => this.#handle(req, res));
    this.server.listen(this.port, this.host, () => {
      this.logger.info?.(`status: http://${this.host}:${this.port}`);
    });
    // Keep the listening handle referenced. Paper/live otherwise rely solely
    // on the market websocket; a book-resync close must not drain the process.
    return this.server;
  }

  close() {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(resolve);
      this.server = null;
    });
  }

  #refresh() {
    const started = performance.now();
    try {
      const status = this.supervisor.health();
      const snapshotAt = Date.now();
      this.lastSnapshotAt = snapshotAt;
      status.monitor = {
        snapshotAt,
        intervalMs: this.snapshotMs,
        buildMs: this.lastBuildMs,
        maxBuildMs: this.maxBuildMs,
        failures: this.snapshotFailures,
        cached: true,
        source: 'pre-serialized-memory',
      };
      const manager = this.supervisor.engine.current?.orders ?? null;
      const orderRound =
        this.supervisor.engine.current?.roundSlug ?? null;
      const orderVersion = manager?.ledgerVersion;
      if (
        orderRound !== this.ordersRound ||
        (
          snapshotAt - this.lastOrdersBuildAt >= this.ordersSnapshotMs &&
          orderVersion !== this.ordersVersion
        )
      ) {
        this.cachedOrders = manager?.ordersSnapshot?.() ?? [];
        this.ordersRound = orderRound;
        this.ordersVersion = orderVersion;
        this.lastOrdersBuildAt = snapshotAt;
      }
      const orders = this.cachedOrders;
      const rounds =
        this.supervisor.settledHistory?.(50) ??
        this.supervisor.engine.history.slice(-50);
      status.orders = orders;
      status.rounds = rounds;
      this.cached.set('/api/status', JSON.stringify(status));
      this.cached.set('/health', this.cached.get('/api/status'));
      this.cached.set('/orders', JSON.stringify(orders));
      this.cached.set('/rounds', JSON.stringify(rounds));
      this.lastBuildMs =
        Math.round((performance.now() - started) * 1000) / 1000;
      this.maxBuildMs = Math.max(this.maxBuildMs, this.lastBuildMs);
    } catch (err) {
      this.snapshotFailures += 1;
      this.cached.set(
        '/api/status',
        JSON.stringify({ ready: false, error: err.message, monitor: { snapshotAt: Date.now() } })
      );
      this.cached.set('/health', this.cached.get('/api/status'));
    }
  }

  #authorised(req, url) {
    if (!this.token) return true;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    return bearer === this.token || url.searchParams.get('token') === this.token;
  }

  #sendJson(res, status, body, extraHeaders = {}) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  }

  #handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (!this.#authorised(req, url)) {
      return this.#sendJson(res, 401, '{"error":"unauthorised"}');
    }

    if (url.pathname === '/api/auto-balance' && req.method === 'POST') {
      return this.#handleAutoBalance(req, res);
    }

    const cached = this.cached.get(url.pathname);
    if (cached !== undefined) {
      const snapshotAgeMs =
        this.lastSnapshotAt > 0
          ? Math.max(0, Date.now() - this.lastSnapshotAt)
          : 0;
      return this.#sendJson(res, 200, cached, {
        'x-snapshot-age-ms': String(snapshotAgeMs),
      });
    }
    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      });
      return res.end(this.dashboard);
    }
    return this.#sendJson(res, 404, '{"error":"not found"}');
  }

  async #handleAutoBalance(req, res) {
    try {
      const result = await this.supervisor.autoBalance();
      const status = result.ok ? 200 : 409;
      return this.#sendJson(res, status, JSON.stringify(result));
    } catch (err) {
      const status = Number.isFinite(err.statusCode) ? err.statusCode : 500;
      return this.#sendJson(
        res,
        status,
        JSON.stringify({ ok: false, error: err.message })
      );
    }
  }
}
