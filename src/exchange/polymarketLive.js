import {
  Side,
  OrderType,
  AssetType,
  CONDITIONAL_TOKEN_DECIMALS,
} from '@polymarket/clob-client-v2';
import { ExchangeAdapter } from './interface.js';
import {
  POLYMARKET_MIN_ORDER_NOTIONAL_USD,
  POLYMARKET_MIN_ORDER_SHARES,
} from '../orderConstraints.js';
import { RateLimiter, PRIORITY } from '../live/rateLimiter.js';

const REQUIRED = [
  'createOrder',
  'postOrder',
  'cancelOrders',
  'getOpenOrders',
  'getBalanceAllowance',
];
const OPTIONAL = [
  'cancelAll',
  'getTickSize',
  'getNegRisk',
  'getOrder',
  'updateBalanceAllowance',
];

const CONDITIONAL_SCALE = 10 ** CONDITIONAL_TOKEN_DECIMALS;

/**
 * Live-only Polymarket CLOB V2 adapter. Paper trading has its own adapter; this
 * class never contains a send-nothing branch.
 */
export class PolymarketLiveAdapter extends ExchangeAdapter {
  constructor({
    client,
    methodMap = {},
    limiter,
    logger = console,
    tickSize = 0.01,
  }) {
    super();
    if (!client) throw new Error('PolymarketLiveAdapter requires a CLOB client');
    this.client = client;
    this.mode = 'live';
    this.logger = logger;
    this.tickSize = tickSize;
    this.tickSizeByToken = new Map();
    this.negRiskByToken = new Map();
    this.limiter =
      limiter ?? new RateLimiter({ capacity: 60, refillPerSec: 8, logger });
    this.methods = this.#probe(methodMap);
  }

  #probe(overrides) {
    const resolve = (name) => {
      if (overrides[name]) return overrides[name];
      return typeof this.client[name] === 'function' ? name : null;
    };
    const methods = {};
    for (const name of REQUIRED) {
      methods[name] = resolve(name);
    }
    for (const name of OPTIONAL) {
      methods[name] = resolve(name);
    }
    const missing = REQUIRED.filter((key) => !methods[key]);
    if (missing.length) {
      throw new Error(
        `PolymarketLiveAdapter: client is missing ${missing.join(', ')}. ` +
          'Refusing live trading against an unverified SDK surface.'
      );
    }
    this.logger.info?.(`clob capability probe: ${JSON.stringify(methods)}`);
    return methods;
  }

  async #tokenOptions(tokenId) {
    const key = String(tokenId);
    let tickSize = this.tickSizeByToken.get(key);
    if (tickSize === undefined) {
      tickSize = this.tickSize;
      if (this.methods.getTickSize) {
        const venueTick = await this.client[this.methods.getTickSize](tokenId);
        const parsed =
          venueTick?.minimum_tick_size ??
          venueTick?.minimumTickSize ??
          venueTick;
        if (Number.isFinite(Number(parsed)) && Number(parsed) > 0) {
          tickSize = Number(parsed);
        }
      }
      this.tickSizeByToken.set(key, tickSize);
    }

    let negRisk = this.negRiskByToken.get(key);
    if (negRisk === undefined) {
      negRisk = false;
      if (this.methods.getNegRisk) {
        negRisk = Boolean(await this.client[this.methods.getNegRisk](tokenId));
      }
      this.negRiskByToken.set(key, negRisk);
    }

    return { tickSize: String(tickSize), negRisk };
  }

  /**
   * Parse BUY fill size from a CLOB order response.
   * takingAmount = shares received; makingAmount = USDC spent.
   */
  static #parseBuyFill(response, limitPrice) {
    const taking = Number(response?.takingAmount ?? response?.taking_amount);
    const making = Number(response?.makingAmount ?? response?.making_amount);
    let filledShares = Number.isFinite(taking) && taking > 0 ? taking : 0;
    let avgPrice = null;
    if (filledShares > 0 && Number.isFinite(making) && making > 0) {
      avgPrice = making / filledShares;
    } else if (filledShares > 0 && Number.isFinite(limitPrice)) {
      avgPrice = limitPrice;
    }
    const matched = Number(
      response?.size_matched ?? response?.sizeMatched ?? response?.filledShares
    );
    if (filledShares <= 0 && Number.isFinite(matched) && matched > 0) {
      filledShares = matched;
      avgPrice = Number.isFinite(limitPrice) ? limitPrice : avgPrice;
    }
    return {
      filledShares,
      avgPrice,
      takingAmount: Number.isFinite(taking) ? taking : null,
      makingAmount: Number.isFinite(making) ? making : null,
      status: response?.status ?? null,
    };
  }

  async getOrderFill(orderId) {
    if (!this.methods.getOrder || !orderId) return null;
    await this.limiter.acquire(1, PRIORITY.PLACE);
    const order = await this.client[this.methods.getOrder](orderId);
    if (!order) return null;
    const matched = Number(order.size_matched ?? order.sizeMatched ?? 0);
    const original = Number(order.original_size ?? order.originalSize ?? 0);
    const price = Number(order.price);
    return {
      orderId: order.id ?? order.orderID ?? orderId,
      filledShares: Number.isFinite(matched) ? matched : 0,
      originalShares: Number.isFinite(original) ? original : null,
      avgPrice: Number.isFinite(price) ? price : null,
      status: order.status ?? null,
      raw: order,
    };
  }

  async placeLimitBuy({
    tokenId,
    price,
    size,
    postOnly = false,
    orderType = OrderType.GTC,
  }) {
    if (!(Number(size) >= POLYMARKET_MIN_ORDER_SHARES)) {
      throw new Error(
        `size ${size} lower than the minimum: ${POLYMARKET_MIN_ORDER_SHARES}`
      );
    }
    const orderNotionalUsd = Number(price) * Number(size);
    if (
      !Number.isFinite(orderNotionalUsd) ||
      orderNotionalUsd + 1e-12 < POLYMARKET_MIN_ORDER_NOTIONAL_USD
    ) {
      throw new Error(
        `order notional $${Number(orderNotionalUsd.toFixed(6))} ` +
          `lower than the minimum: $${POLYMARKET_MIN_ORDER_NOTIONAL_USD}`
      );
    }
    await this.limiter.acquire(1, PRIORITY.PLACE);
    const options = await this.#tokenOptions(tokenId);
    const order = await this.client[this.methods.createOrder](
      { tokenID: tokenId, price, size, side: Side.BUY },
      options
    );
    const type =
      orderType === OrderType.FAK || orderType === 'FAK'
        ? OrderType.FAK
        : OrderType.GTC;
    const postOnlyFlag = type === OrderType.FAK ? false : postOnly;
    // V2: postOrder(order, orderType?, postOnly?, deferExec?)
    const response = await this.client[this.methods.postOrder](
      order,
      type,
      postOnlyFlag
    );
    const orderId = response?.orderID ?? response?.orderId ?? response?.id;
    if (!orderId) {
      throw new Error(`postOrder returned no id: ${JSON.stringify(response)}`);
    }

    let fill = PolymarketLiveAdapter.#parseBuyFill(response, price);
    if (
      type === OrderType.FAK &&
      fill.filledShares <= 0 &&
      this.methods.getOrder
    ) {
      try {
        const polled = await this.getOrderFill(orderId);
        if (polled && polled.filledShares > 0) {
          fill = {
            filledShares: polled.filledShares,
            avgPrice: polled.avgPrice ?? price,
            takingAmount: polled.filledShares,
            makingAmount:
              polled.avgPrice != null
                ? polled.avgPrice * polled.filledShares
                : null,
            status: polled.status ?? fill.status,
          };
        }
      } catch (err) {
        this.logger.warn?.(`getOrderFill failed ${orderId}: ${err.message}`);
      }
    }

    return {
      orderId,
      status: fill.status,
      filledShares: fill.filledShares,
      avgPrice: fill.avgPrice,
      takingAmount: fill.takingAmount,
      makingAmount: fill.makingAmount,
      raw: response,
    };
  }

  async cancelOrders(orderIds) {
    const ids = orderIds.filter(Boolean);
    if (!ids.length) return;
    await this.limiter.acquire(1, PRIORITY.CANCEL);
    await this.client[this.methods.cancelOrders](ids);
  }

  async cancelEverything() {
    if (this.methods.cancelAll) {
      await this.limiter.acquire(1, PRIORITY.CANCEL);
      await this.client[this.methods.cancelAll]();
      return { cancelled: 'all' };
    }
    const open = await this.client[this.methods.getOpenOrders]();
    const ids = (open ?? []).map((order) => order.id ?? order.orderID).filter(Boolean);
    if (ids.length) await this.cancelOrders(ids);
    return { cancelled: ids.length };
  }

  async listOpenOrders() {
    return this.client[this.methods.getOpenOrders]();
  }

  /**
   * Authoritative outcome-token share balance for restart reconciliation.
   * Balances are returned in wei; divide by CONDITIONAL_TOKEN_DECIMALS.
   */
  async getConditionalShares(tokenId) {
    if (!tokenId) {
      throw new Error('getConditionalShares: tokenId is required');
    }
    const params = {
      asset_type: AssetType.CONDITIONAL,
      token_id: String(tokenId),
    };
    if (this.methods.updateBalanceAllowance) {
      await this.limiter.acquire(1, PRIORITY.PLACE);
      await this.client[this.methods.updateBalanceAllowance](params);
    }
    await this.limiter.acquire(1, PRIORITY.PLACE);
    const response = await this.client[this.methods.getBalanceAllowance](params);
    const raw = response?.balance ?? response?.Balance ?? 0;
    const wei = Number(raw);
    if (!Number.isFinite(wei) || wei < 0) {
      throw new Error(
        `getConditionalShares: invalid balance for ${tokenId}: ${JSON.stringify(response)}`
      );
    }
    return wei / CONDITIONAL_SCALE;
  }

  async getFeeSchedule() {
    const bps = this.assertedFeeBps;
    if (!Number.isFinite(bps) || bps < 0) {
      throw new Error('getFeeSchedule: set adapter.assertedFeeBps from your verified fee tier');
    }
    return { takerBps: bps, makerBps: bps };
  }

  async redeem() {
    throw new Error('redeem is an on-chain CTF call, not a CLOB method');
  }
}
