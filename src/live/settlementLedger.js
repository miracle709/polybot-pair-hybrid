const round6 = (value) => Math.round(Number(value) * 1e6) / 1e6;

const finiteOr = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const EASTERN_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const slugEndEpoch = (slug) => {
  if (typeof slug !== 'string') return null;
  const start = Number(slug.slice(slug.lastIndexOf('-') + 1));
  return Number.isInteger(start) && start > 1_000_000_000
    ? start + 300
    : null;
};

export function easternDateKey(epochSeconds) {
  const ms = Number(epochSeconds) * 1000;
  if (!Number.isFinite(ms)) return null;
  const parts = EASTERN_DATE_FORMATTER.formatToParts(new Date(ms));
  const part = (type) => parts.find((x) => x.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function normalizeSettlement(row) {
  if (!row || typeof row !== 'object') return null;
  const roundSlug = row.roundSlug ?? row.round_slug;
  const pnlUsd = finiteOr(row.pnlUsd ?? row.pnl_usdc);
  if (!roundSlug || pnlUsd === null) return null;
  const winnerRaw = String(row.winner ?? row.outcome ?? '').toUpperCase();
  const winner =
    winnerRaw === 'UP' || winnerRaw === 'YES'
      ? 'UP'
      : winnerRaw === 'DOWN' || winnerRaw === 'NO'
        ? 'DOWN'
        : winnerRaw === 'HEDGED'
          ? 'HEDGED'
          : winnerRaw || null;
  const observedAt =
    finiteOr(row.settledAtEpoch ?? row.ts) ??
    Date.now() / 1000;
  // Attribute realized PnL to the market window, not to a variable API
  // observation delay. This keeps ET daily totals deterministic at midnight.
  const ts = slugEndEpoch(roundSlug) ?? observedAt;

  return {
    ...row,
    roundSlug,
    winner,
    pnlUsd: round6(pnlUsd),
    costUsd: finiteOr(row.costUsd ?? row.volume_usdc, null),
    feeUsd: finiteOr(row.feeUsd ?? row.fee_usd, 0),
    payoutUsd: finiteOr(row.payoutUsd ?? row.payout_usd, null),
    settledBy: row.settledBy ?? row.settled_by ?? null,
    resolvedWinner:
      row.resolvedWinner != null
        ? String(row.resolvedWinner).toUpperCase()
        : null,
    upShares: finiteOr(row.upShares ?? row.net_shares_up, null),
    downShares: finiteOr(row.downShares ?? row.net_shares_down, null),
    upAvgMils: finiteOr(row.upAvgMils, null),
    downAvgMils: finiteOr(row.downAvgMils, null),
    matchedShares: finiteOr(row.matchedShares ?? row.matched, null),
    ts,
    settledAtEpoch: observedAt,
  };
}

/**
 * Deduplicated cumulative PnL restored from round_results.json.
 *
 * Updates happen once per settlement, never in the quote path. Totals and
 * daily totals are cached, so dashboard snapshots remain O(1).
 */
export class SettlementLedger {
  constructor(rows = []) {
    this.byRound = new Map();
    this.byEasternDate = new Map();
    this.totalPnlUsd = 0;
    this.sorted = [];
    for (const row of Array.isArray(rows) ? rows : []) this.upsert(row);
  }

  upsert(input) {
    const row = normalizeSettlement(input);
    if (!row) return null;
    const prior = this.byRound.get(row.roundSlug);
    if (prior) this.#removeTotals(prior);
    this.byRound.set(row.roundSlug, row);
    this.#addTotals(row);
    this.sorted = [...this.byRound.values()].sort(
      (a, b) => a.ts - b.ts || a.roundSlug.localeCompare(b.roundSlug)
    );
    return row;
  }

  #addTotals(row) {
    this.totalPnlUsd = round6(this.totalPnlUsd + row.pnlUsd);
    const key = easternDateKey(row.ts);
    if (key) {
      this.byEasternDate.set(
        key,
        round6((this.byEasternDate.get(key) ?? 0) + row.pnlUsd)
      );
    }
  }

  #removeTotals(row) {
    this.totalPnlUsd = round6(this.totalPnlUsd - row.pnlUsd);
    const key = easternDateKey(row.ts);
    if (key) {
      this.byEasternDate.set(
        key,
        round6((this.byEasternDate.get(key) ?? 0) - row.pnlUsd)
      );
    }
  }

  dailyTotal(epochSeconds) {
    return this.byEasternDate.get(easternDateKey(epochSeconds)) ?? 0;
  }

  history(limit = 50) {
    return this.sorted.slice(-Math.max(0, limit));
  }

  has(roundSlug) {
    return this.byRound.has(roundSlug);
  }

  get size() {
    return this.byRound.size;
  }

  get latest() {
    return this.sorted.at(-1) ?? null;
  }
}
