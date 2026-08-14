/**
 * Validation harness.
 *
 * A correct clone reproduces these against a replay of the same market
 * data. Targets come from the reconstruction over 1,473 rounds / 124.2h.
 * If a run fails several of these, the implementation has drifted from the
 * target wallet — not necessarily worse, but no longer a clone.
 */

export const TARGETS = [
  { key: 'fillsBeforeGate',    label: 'fills before entry gate',       expect: (v) => v === 0,                  want: '0' },
  { key: 'fillsOutsideBand',   label: 'fills outside 0.12-0.89',       expect: (v) => v < 0.002,                want: '<0.2%' },
  { key: 'bothSidesRate',      label: 'rounds holding both legs',      expect: (v) => v > 0.95,                 want: '>95%' },
  { key: 'medianSeedSecond',   label: 'median seed second',            expect: (v) => v >= 18 && v <= 35,       want: '18-35s' },
  { key: 'sells',              label: 'sells',                         expect: (v) => v === 0,                  want: '0' },
  { key: 'medianPairCost',     label: 'median avgUp+avgDn (mils)',     expect: (v) => v <= 992,                 want: '<=992' },
  { key: 'pairCostBelow100',   label: 'rounds with pair cost < 1.00',  expect: (v) => v >= 0.54,                want: '>=54%' },
  { key: 'tiltAlignment',      label: 'tilt aligns with winner',       expect: (v) => v >= 0.45 && v <= 0.55,   want: '48-52% (must be a coinflip)' },
  { key: 'maxClipShares',      label: 'max single fill (shares)',      expect: (v) => v <= 90.001,              want: '<=90' },
  { key: 'medianOffsetTicks',  label: 'median ticks behind bid',       expect: (v) => v === 1,                  want: '1' },
];

export function summarise(roundResults, fills, opts = {}) {
  const params = opts.params;
  const n = roundResults.length;
  if (n === 0) return { rounds: 0 };

  const median = (xs) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const pairCosts = roundResults.map((r) => r.pairCostMils).filter((x) => x != null);
  const seeds = roundResults.map((r) => r.firstFillSecond).filter((x) => x != null);

  const tiltAligned = roundResults.filter((r) => Math.abs(r.tiltShares) > 1);
  const alignment =
    tiltAligned.length === 0
      ? NaN
      : tiltAligned.filter(
          (r) => (r.tiltShares > 0 && r.winner === 'UP') || (r.tiltShares < 0 && r.winner === 'DOWN')
        ).length / tiltAligned.length;

  const totalPnl = roundResults.reduce((s, r) => s + r.pnlUsd, 0);
  const totalCost = roundResults.reduce((s, r) => s + r.costUsd, 0);
  const pnls = roundResults.map((r) => r.pnlUsd);
  const mean = totalPnl / n;
  const sd = Math.sqrt(pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));

  return {
    rounds: n,
    fills: fills.length,
    fillsBeforeGate: fills.filter((f) => f.secondsIntoRound < (params?.ENTRY_GATE_SECONDS ?? 13)).length,
    fillsOutsideBand:
      fills.filter((f) => f.price < 0.12 - 1e-9 || f.price > 0.89 + 1e-9).length / Math.max(1, fills.length),
    bothSidesRate: roundResults.filter((r) => r.matchedShares > 0).length / n,
    medianSeedSecond: median(seeds),
    sells: fills.filter((f) => f.side === 'SELL').length,
    medianPairCost: median(pairCosts),
    pairCostBelow100: pairCosts.filter((x) => x < 1000).length / Math.max(1, pairCosts.length),
    tiltAlignment: alignment,
    maxClipShares: fills.reduce((m, f) => Math.max(m, f.size), 0),
    medianOffsetTicks: median(fills.map((f) => f.offsetTicks).filter((x) => x != null)),
    totalPnlUsd: round2(totalPnl),
    totalCostUsd: round2(totalCost),
    yieldOnDeployment: totalCost > 0 ? totalPnl / totalCost : 0,
    pnlPerRound: round2(mean),
    pnlSdPerRound: round2(sd),
    tStat: sd > 0 ? round2(mean / (sd / Math.sqrt(n))) : 0,
  };
}

export function report(summary) {
  const lines = [
    `rounds ${summary.rounds}  fills ${summary.fills}`,
    `pnl $${summary.totalPnlUsd} on $${summary.totalCostUsd} deployed  ` +
      `(${(summary.yieldOnDeployment * 100).toFixed(2)}% of deployment)`,
    `per round $${summary.pnlPerRound} +/- ${summary.pnlSdPerRound}  t=${summary.tStat}`,
    '',
    'check                                value        target',
  ];
  for (const t of TARGETS) {
    const v = summary[t.key];
    const ok = t.expect(v) ? 'PASS' : 'FAIL';
    const shown = typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : String(v);
    lines.push(`${ok}  ${t.label.padEnd(32)} ${String(shown).padEnd(12)} ${t.want}`);
  }
  // A t-stat reminder, because this matters more than people expect:
  // over 633 scored rounds his own realized edge is $4.33/round with
  // se $2.24, i.e. t = 1.94. A few hundred replayed rounds cannot
  // distinguish a good clone from a lucky one.
  lines.push('');
  lines.push(
    `note: with sd $${summary.pnlSdPerRound}/round you need ~${Math.ceil(
      (2 * summary.pnlSdPerRound / Math.max(0.01, Math.abs(summary.pnlPerRound))) ** 2
    )} rounds for t=2.`
  );
  return lines.join('\n');
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
