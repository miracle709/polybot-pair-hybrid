/**
 * poly-btc5m-pair-mm — public surface.
 *
 * Reconstruction of the two-sided pair-accumulation strategy run by
 * Polymarket wallet 0x3048d65321be3497164cdfc2996f94f98a2e7537 on
 * btc-updown-5m-* markets. See README.md for provenance and the measured
 * parameter table.
 */

// --- configuration ----------------------------------------------------------
export { PARAMS, GUARDS, MARKET } from './src/config.js';

// --- core domain ------------------------------------------------------------
export { LegBook, MarketBook } from './src/book.js';
export { RoundInventory } from './src/inventory.js';
export { toMils, toProb, tickSizeMils, stepTicks, complementMils } from './src/util.js';

// --- strategy ---------------------------------------------------------------
export {
  computeDesiredRungs,
  computeRungShares,
  SuppressReason,
} from './src/quoter.js';
export { OrderManager } from './src/orderManager.js';
export { RoundRunner, RoundState } from './src/roundRunner.js';
export { Engine } from './src/engine.js';

// --- exchange adapters ------------------------------------------------------
export { ExchangeAdapter } from './src/exchange/interface.js';
export { PaperExchange } from './src/exchange/paperExchange.js';
export { PolymarketLiveAdapter } from './src/exchange/polymarketLive.js';

// --- live infrastructure ----------------------------------------------------
export { Supervisor } from './src/live/supervisor.js';
export { MarketFeed, UserFeed } from './src/live/feeds.js';
export { BookState } from './src/live/bookState.js';
export { MarketResolver } from './src/live/marketResolver.js';
export { RateLimiter, PRIORITY } from './src/live/rateLimiter.js';
export { StatusServer } from './src/live/statusServer.js';

// --- activity log -----------------------------------------------------------
export { ActivityRecorder, NullRecorder } from './src/log/recorder.js';
export { EventType, OrderStatus } from './src/log/schema.js';
export * as LogSchema from './src/log/schema.js';

// --- backtest / validation --------------------------------------------------
export { replay } from './src/replay.js';
export { summarise, report, TARGETS } from './src/metrics.js';

// --- price-to-beat sources --------------------------------------------------
export {
  PriceToBeatProvider,
  HttpPriceToBeatProvider,
  ChainlinkPriceToBeatProvider,
  StaticPriceToBeatProvider,
} from './src/live/priceToBeat.js';
