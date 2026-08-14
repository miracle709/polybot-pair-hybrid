export const SourceQuality = Object.freeze({
  AUTHORITATIVE: 'AUTHORITATIVE',
  APPROXIMATE: 'APPROXIMATE',
  UNTRUSTED: 'UNTRUSTED',
});

const VALUES = new Set(Object.values(SourceQuality));

/**
 * Source quality is explicit first and conservative by default. Ambiguous
 * names such as "chainlink" are not upgraded merely because they sound
 * authoritative; Data Streams and the on-chain aggregator are different.
 */
export function sourceQuality(source, explicitQuality = null) {
  const normalizedQuality = String(explicitQuality ?? '').toUpperCase();
  if (VALUES.has(normalizedQuality)) return normalizedQuality;
  const value = String(source ?? '').trim().toLowerCase();
  if (!value) return SourceQuality.UNTRUSTED;
  if (
    value.includes('chainlink_data_stream') ||
    value.includes('chainlink-data-stream') ||
    value.includes('settlement_authoritative') ||
    value.includes('authoritative_tracker')
  ) {
    return SourceQuality.AUTHORITATIVE;
  }
  if (
    value.includes('onchain_approx') ||
    value.includes('on-chain_approx') ||
    value.includes('approximate') ||
    value.includes('binance') ||
    value.includes('coinbase') ||
    value.includes('kraken') ||
    value.includes('spot') ||
    value.startsWith('gamma:')
  ) {
    return SourceQuality.APPROXIMATE;
  }
  return SourceQuality.UNTRUSTED;
}

export function isAuthoritativeSource(source, explicitQuality = null) {
  return sourceQuality(source, explicitQuality) === SourceQuality.AUTHORITATIVE;
}
