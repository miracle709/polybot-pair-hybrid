import { TimeSeriesBuffer } from './timeSeriesBuffer.js';
import { fixedHorizonReturns } from './momentum.js';
import { exOwnBookFeatures } from './bookFeatures.js';
import {
  legacyGapDirection,
  settlementGap,
  twapGapBps,
} from './settlementGap.js';
import { createSignalSnapshot } from './signalSnapshot.js';
import { SourceQuality, sourceQuality } from './sourceQuality.js';

function msFromSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function ageMs(decisionTimeMs, point) {
  return point ? Math.max(0, decisionTimeMs - point.publisherTimeMs) : null;
}

function returnValue(returns, seconds) {
  return returns[seconds]?.value ?? null;
}

function horizonTimestamps(prefix, returns) {
  const output = {};
  for (const seconds of [1, 3, 5, 10]) {
    const result = returns[seconds];
    output[`${prefix}${seconds}sCurrentPublisherTimeMs`] =
      result?.current?.publisherTimeMs ?? null;
    output[`${prefix}${seconds}sCurrentArrivalTimeMs`] =
      result?.current?.arrivalTimeMs ?? null;
    output[`${prefix}${seconds}sPastPublisherTimeMs`] =
      result?.past?.publisherTimeMs ?? null;
    output[`${prefix}${seconds}sPastArrivalTimeMs`] =
      result?.past?.arrivalTimeMs ?? null;
    output[`${prefix}${seconds}sTargetTimeMs`] = result?.targetTimeMs ?? null;
  }
  return output;
}

export class FeatureEngine {
  constructor({
    roundSlug,
    windowStartEpoch,
    roundSeconds = 300,
    bookMaxAgeMs = 1000,
    btcMaxAgeMs = 1000,
    referenceMaxAgeMs = 1500,
    volatilityWindowMs = 30_000,
    twapWindowMs = 30_000,
  }) {
    this.roundSlug = roundSlug;
    this.windowStartEpoch = Number(windowStartEpoch);
    this.roundSeconds = Number(roundSeconds);
    this.bookMaxAgeMs = Number(bookMaxAgeMs);
    this.btcMaxAgeMs = Number(btcMaxAgeMs);
    this.referenceMaxAgeMs = Number(referenceMaxAgeMs);
    this.volatilityWindowMs = Number(volatilityWindowMs);
    this.twapWindowMs = Number(twapWindowMs);
    this.btc = new TimeSeriesBuffer();
    this.reference = new TimeSeriesBuffer();
    this.clobUpMid = new TimeSeriesBuffer();
  }

  observeBtc(observation) {
    return this.btc.add({
      value: observation.price ?? observation.value,
      publisherTimeMs: observation.publisherTimeMs ?? observation.publisherTime,
      arrivalTimeMs: observation.arrivalTimeMs ?? observation.arrivalTime,
      source: observation.source,
      sourceQuality: observation.sourceQuality ?? observation.quality,
      metadata: observation.metadata ?? null,
    });
  }

  observeSettlementReference(observation) {
    return this.reference.add({
      value: observation.price ?? observation.value,
      publisherTimeMs: observation.publisherTimeMs ?? observation.publisherTime,
      arrivalTimeMs: observation.arrivalTimeMs ?? observation.arrivalTime,
      source: observation.source,
      sourceQuality: observation.sourceQuality ?? observation.quality,
      metadata: observation.metadata ?? null,
    });
  }

  buildSnapshot({
    books,
    ownOrders = [],
    priceToBeat = null,
    decisionTimeMs = Date.now(),
    roundSecond = null,
  }) {
    const decision = Number(decisionTimeMs);
    const sec = roundSecond == null
      ? decision / 1000 - this.windowStartEpoch
      : Number(roundSecond);
    const remaining = Math.max(0, this.roundSeconds - sec);
    const invalid = [];
    const exOwn = exOwnBookFeatures(books, ownOrders);
    const upBookTimeMs = msFromSeconds(books?.UP?.ts);
    const downBookTimeMs = msFromSeconds(books?.DOWN?.ts);
    const bookPublisherTimeMs =
      upBookTimeMs == null || downBookTimeMs == null
        ? null
        : Math.min(upBookTimeMs, downBookTimeMs);
    if (bookPublisherTimeMs == null) invalid.push('book_timestamp_missing');
    else if (bookPublisherTimeMs > decision) invalid.push('book_future_timestamp');
    if (exOwn.up.midMils != null && bookPublisherTimeMs != null && bookPublisherTimeMs <= decision) {
      this.clobUpMid.add({
        value: exOwn.up.midMils / 1000,
        publisherTimeMs: bookPublisherTimeMs,
        arrivalTimeMs: decision,
        source: 'polymarket_ex_own_mid',
        sourceQuality: SourceQuality.AUTHORITATIVE,
      });
    }

    const btcCurrent = this.btc.latestAtOrBefore(decision, decision);
    const referenceCurrent = this.reference.latestAtOrBefore(decision, decision);
    const btcReturns = fixedHorizonReturns(this.btc, decision);
    const clobReturns = fixedHorizonReturns(this.clobUpMid, decision);
    const twap = this.reference.timeWeightedAverage(decision, this.twapWindowMs);
    const volatility = this.btc.realizedVolatility(decision, this.volatilityWindowMs);
    const ptbValue = Number(priceToBeat?.ptb ?? priceToBeat?.price);
    const ptbSource = priceToBeat?.src ?? priceToBeat?.source ?? null;
    const ptbQuality = sourceQuality(
      ptbSource,
      priceToBeat?.sourceQuality ?? priceToBeat?.quality
    );
    const ptbPublisherTimeMs = Number(
      priceToBeat?.publisherTimeMs ?? priceToBeat?.captureTimeMs
    );
    const ptbArrivalTimeMs = Number(
      priceToBeat?.arrivalTimeMs ?? priceToBeat?.captureTimeMs
    );
    if (
      (Number.isFinite(ptbPublisherTimeMs) && ptbPublisherTimeMs > decision) ||
      (Number.isFinite(ptbArrivalTimeMs) && ptbArrivalTimeMs > decision)
    ) invalid.push('price_to_beat_future_timestamp');
    const referenceQuality = sourceQuality(
      referenceCurrent?.source,
      referenceCurrent?.sourceQuality
    );
    let gap = null;
    let twapGap = null;
    if (Number.isFinite(ptbValue) && ptbValue > 0 && referenceCurrent?.value > 0) {
      gap = settlementGap({
        settlementReferencePrice: referenceCurrent.value,
        priceToBeat: ptbValue,
      });
    } else invalid.push('settlement_gap_missing');
    if (Number.isFinite(ptbValue) && ptbValue > 0 && twap?.value > 0) {
      twapGap = twapGapBps({ twapPrice: twap.value, priceToBeat: ptbValue });
    } else invalid.push('reference_twap_history_missing');

    const bookAge = bookPublisherTimeMs == null
      ? null
      : Math.max(0, decision - bookPublisherTimeMs);
    const btcAge = ageMs(decision, btcCurrent);
    const referenceAge = ageMs(decision, referenceCurrent);
    if (bookAge == null || bookAge > this.bookMaxAgeMs) invalid.push('book_stale');
    if (btcAge == null || btcAge > this.btcMaxAgeMs) invalid.push('btc_stale');
    if (referenceAge == null || referenceAge > this.referenceMaxAgeMs) {
      invalid.push('settlement_reference_stale');
    }
    if (ptbQuality !== SourceQuality.AUTHORITATIVE) {
      invalid.push('price_to_beat_not_authoritative');
    }
    if (referenceQuality !== SourceQuality.AUTHORITATIVE) {
      invalid.push('settlement_reference_not_authoritative');
    }
    if (exOwn.ownQuoteContaminated) invalid.push('own_quote_contaminated');
    if (!books?.bothUsable?.()) invalid.push('book_unusable');
    if (Object.values(btcReturns).some((value) => value == null)) {
      invalid.push('btc_history_missing');
    }
    if (Object.values(clobReturns).some((value) => value == null)) {
      invalid.push('clob_history_missing');
    }
    if (!volatility) invalid.push('volatility_missing');

    const rawGapBps = gap?.rawGapBps ?? null;
    const snapshotId = [
      this.roundSlug,
      Math.trunc(decision),
      btcCurrent?.publisherTimeMs ?? 'na',
      referenceCurrent?.publisherTimeMs ?? 'na',
      bookPublisherTimeMs ?? 'na',
    ].join(':');
    return createSignalSnapshot({
      snapshotId,
      decisionTimeMs: decision,
      roundId: this.roundSlug,
      roundSecond: sec,
      timeRemainingSeconds: remaining,
      priceToBeat: Number.isFinite(ptbValue) && ptbValue > 0 ? ptbValue : null,
      priceToBeatSource: ptbSource,
      priceToBeatSourceQuality: ptbQuality,
      settlementReferencePrice: referenceCurrent?.value ?? null,
      settlementReferenceSource: referenceCurrent?.source ?? null,
      settlementReferenceSourceQuality: referenceQuality,
      rawGapBps,
      logGapBps: gap?.logGapBps ?? null,
      twap30GapBps: twapGap,
      legacyGapDirection: legacyGapDirection(rawGapBps),
      btcReturn1sBps: returnValue(btcReturns, 1),
      btcReturn3sBps: returnValue(btcReturns, 3),
      btcReturn5sBps: returnValue(btcReturns, 5),
      btcReturn10sBps: returnValue(btcReturns, 10),
      clobReturn1sBps: returnValue(clobReturns, 1),
      clobReturn3sBps: returnValue(clobReturns, 3),
      clobReturn5sBps: returnValue(clobReturns, 5),
      clobReturn10sBps: returnValue(clobReturns, 10),
      upMid: exOwn.up.midMils == null ? null : exOwn.up.midMils / 1000,
      downMid: exOwn.down.midMils == null ? null : exOwn.down.midMils / 1000,
      upBestBid: exOwn.up.bestBid == null ? null : exOwn.up.bestBid / 1000,
      upBestAsk: exOwn.up.bestAsk == null ? null : exOwn.up.bestAsk / 1000,
      downBestBid: exOwn.down.bestBid == null ? null : exOwn.down.bestBid / 1000,
      downBestAsk: exOwn.down.bestAsk == null ? null : exOwn.down.bestAsk / 1000,
      exOwnBestBid: exOwn.up.bestBid == null ? null : exOwn.up.bestBid / 1000,
      exOwnMid: exOwn.up.midMils == null ? null : exOwn.up.midMils / 1000,
      spread: {
        upMils: exOwn.up.spreadMils,
        downMils: exOwn.down.spreadMils,
      },
      orderBookImbalance: exOwn.up.imbalance,
      depthFeatures: {
        upBid: exOwn.up.bidDepth,
        upAsk: exOwn.up.askDepth,
        downBid: exOwn.down.bidDepth,
        downAsk: exOwn.down.askDepth,
      },
      realizedVolatility: volatility?.value ?? null,
      remainingVolatilityEstimate:
        volatility == null ? null : 10_000 * volatility.value * Math.sqrt(remaining),
      bookAgeMs: bookAge,
      btcAgeMs: btcAge,
      settlementPriceAgeMs: referenceAge,
      ownQuoteContaminated: exOwn.ownQuoteContaminated,
      sourceTimestamps: {
        bookPublisherTimeMs,
        bookArrivalTimeMs: decision,
        btcPublisherTimeMs: btcCurrent?.publisherTimeMs ?? null,
        btcArrivalTimeMs: btcCurrent?.arrivalTimeMs ?? null,
        settlementPublisherTimeMs: referenceCurrent?.publisherTimeMs ?? null,
        settlementArrivalTimeMs: referenceCurrent?.arrivalTimeMs ?? null,
        priceToBeatPublisherTimeMs:
          Number.isFinite(ptbPublisherTimeMs) ? ptbPublisherTimeMs : null,
        priceToBeatArrivalTimeMs:
          Number.isFinite(ptbArrivalTimeMs) ? ptbArrivalTimeMs : null,
        ...horizonTimestamps('btc', btcReturns),
        ...horizonTimestamps('clob', clobReturns),
      },
      valid: invalid.length === 0,
      invalidReasons: [...new Set(invalid)],
    });
  }
}
