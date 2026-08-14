import fs from 'node:fs';
import path from 'node:path';
import { roundAccounting } from '../util.js';

const slugStart = (roundSlug) => {
  if (typeof roundSlug !== 'string') return null;
  const start = Number(
    roundSlug.slice(roundSlug.lastIndexOf('-') + 1)
  );
  return Number.isInteger(start) ? start : null;
};

/**
 * One-time recovery for clean legacy paper runs made before unresolved-round
 * snapshots existed.
 *
 * Deliberately strict:
 * - scans only this bot's configured log directory;
 * - ignores large target-wallet captures;
 * - requires a clean PAPER shutdown with zero dropped recorder events;
 * - accepts only rich incremental WALLET_FILL rows carrying rid/p/sh.
 *
 * This is startup/cold-path work and is never called from onBook/onFill.
 */
export async function recoverLegacyPaperSnapshots({
  dir = './logs',
  knownRounds = new Set(),
  excludeFile = null,
  nowEpochSeconds = Date.now() / 1000,
  maxFileBytes = 32 * 1024 * 1024,
  maxFiles = 12,
  logger = console,
} = {}) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, {
      withFileTypes: true,
    });
  } catch {
    return [];
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(dir, entry.name);
    if (
      excludeFile &&
      path.resolve(file) === path.resolve(excludeFile)
    ) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const stat = await fs.promises.stat(file);
      if (stat.size <= 0 || stat.size > maxFileBytes) continue;
      candidates.push({ file, mtimeMs: stat.mtimeMs });
    } catch {
      // File rotated between readdir/stat.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { file } of candidates.slice(0, maxFiles)) {
    let text;
    try {
      // eslint-disable-next-line no-await-in-loop
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (
      !text.includes('"type":"WALLET_FILL"') ||
      !text.includes('"mode":"paper"') ||
      !text.includes('"event":"shutdown"')
    ) continue;

    let cleanPaperShutdown = false;
    const rounds = new Map();
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        event.type === 'HEALTH' &&
        event.event === 'shutdown' &&
        event.mode === 'paper' &&
        Number(event.recorder?.dropped ?? 0) === 0
      ) {
        cleanPaperShutdown = true;
      }
      if (
        event.type !== 'WALLET_FILL' ||
        event.side !== 'BUY' ||
        !event.rid ||
        !Number.isFinite(Number(event.p)) ||
        !Number.isFinite(Number(event.sh))
      ) continue;

      const roundSlug = event.rid;
      const start = slugStart(roundSlug);
      if (
        start === null ||
        start + 300 > nowEpochSeconds ||
        knownRounds.has(roundSlug)
      ) continue;
      const leg = String(event.leg ?? event.outcome).toUpperCase();
      if (leg !== 'UP' && leg !== 'DOWN') continue;
      const shares = Number(event.sh);
      const mils = Number(event.p);
      if (shares <= 0 || mils <= 0 || mils >= 1000) continue;

      let row = rounds.get(roundSlug);
      if (!row) {
        row = {
          roundSlug,
          windowStartEpoch: start,
          windowEndEpoch: start + 300,
          conditionId: null,
          upIndex: null,
          upShares: 0,
          downShares: 0,
          upCostUsd: 0,
          downCostUsd: 0,
          upFillCount: 0,
          downFillCount: 0,
          feeUsd: 0,
          fillCount: 0,
          firstFillSecond: null,
          lastFillSecond: null,
          source: 'legacy_clean_paper_log',
          sourceFile: path.basename(file),
        };
        rounds.set(roundSlug, row);
      }
      if (leg === 'UP') {
        row.upShares = roundAccounting(row.upShares + shares);
        row.upCostUsd = roundAccounting(
          row.upCostUsd + (shares * mils) / 1000
        );
        row.upFillCount += 1;
      } else {
        row.downShares = roundAccounting(row.downShares + shares);
        row.downCostUsd = roundAccounting(
          row.downCostUsd + (shares * mils) / 1000
        );
        row.downFillCount += 1;
      }
      row.feeUsd = roundAccounting(
        row.feeUsd + Number(event.fee ?? 0)
      );
      row.fillCount += 1;
      const sec = Number(
        event.sec ?? event.seconds_into_round
      );
      if (Number.isFinite(sec)) {
        row.firstFillSecond =
          row.firstFillSecond === null
            ? sec
            : Math.min(row.firstFillSecond, sec);
        row.lastFillSecond =
          row.lastFillSecond === null
            ? sec
            : Math.max(row.lastFillSecond, sec);
      }
    }

    if (!cleanPaperShutdown || rounds.size === 0) continue;
    const recovered = [...rounds.values()].sort(
      (a, b) => a.windowStartEpoch - b.windowStartEpoch
    );
    logger.info?.(
      `recovered ${recovered.length} unresolved paper round(s) from ${path.basename(file)}`
    );
    return recovered;
  }
  return [];
}
