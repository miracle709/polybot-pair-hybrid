/**
 * Exchange adapter contract.
 *
 * The strategy is venue-agnostic; everything Polymarket-specific lives
 * behind this interface. Implement it once against @polymarket/clob-client-v2
 * and the same quoter drives live trading, paper trading and replay.
 *
 * All prices crossing this boundary are probabilities in [0.001, 0.999].
 * Integer mils stop at the boundary.
 *
 * Implementations: PaperExchange (paper + JSONL L2 sim) and
 * PolymarketLiveAdapter (live execution only).
 */
export class ExchangeAdapter {
  /**
   * @param {Object} req
   * @param {string} req.tokenId    ERC-1155 position id for the outcome
   * @param {number} req.price      0.01..0.99
   * @param {number} req.size       shares
   * @param {string} req.roundSlug
   * @param {boolean} [req.postOnly] maker quotes default true; FAK forces false
   * @param {'GTC'|'FAK'} [req.orderType] default GTC; FAK is fill-and-kill taker
   * @param {boolean} [req.protection] paper/live flag for profit-protect hedges
   * @returns {Promise<{orderId:string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async placeLimitBuy(req) {
    throw new Error('not implemented');
  }

  /** @param {string[]} orderIds @returns {Promise<void>} */
  // eslint-disable-next-line no-unused-vars
  async cancelOrders(orderIds) {
    throw new Error('not implemented');
  }

  /** Optional. Redeem winning shares after resolution. */
  // eslint-disable-next-line no-unused-vars
  async redeem(req) {
    throw new Error('not implemented');
  }

  /**
   * Optional preflight. Must return the effective taker/maker fee your
   * account actually pays, in bps of notional. See config note on
   * ASSUMED_FEE_BPS_OF_NOTIONAL — this is the single input that decides
   * whether the strategy is viable at all.
   * @returns {Promise<{takerBps:number, makerBps:number}>}
   */
  async getFeeSchedule() {
    throw new Error('not implemented');
  }
}
