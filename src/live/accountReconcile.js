/**
 * Venue-verified restart reconciliation for live pending inventory.
 *
 * Cost basis is never invented from the venue — only share counts are
 * compared. Verified snapshots keep local costs for settlement / hydrate.
 */

export const SHARE_EPSILON = 0.01;

const STATUS = Object.freeze({
  VERIFIED: 'verified',
  MISMATCH: 'mismatch',
  MISSING_TOKENS: 'missing_tokens',
  FETCH_ERROR: 'fetch_error',
});

function finiteShares(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function sharesMatch(a, b, epsilon = SHARE_EPSILON) {
  return Math.abs(finiteShares(a) - finiteShares(b)) <= epsilon;
}

/**
 * @param {object} snapshot pending settlement row
 * @param {(tokenId: string) => Promise<number>} getShares
 * @param {number} [epsilon]
 * @returns {Promise<{
 *   roundSlug: string,
 *   status: string,
 *   snapshot: object,
 *   venue?: { upShares: number, downShares: number },
 *   error?: string,
 * }>}
 */
export async function reconcilePendingSnapshot(
  snapshot,
  getShares,
  epsilon = SHARE_EPSILON
) {
  const roundSlug = String(snapshot?.roundSlug ?? '');
  const tokenIds = snapshot?.tokenIds;
  const upToken = tokenIds?.UP;
  const downToken = tokenIds?.DOWN;
  if (!roundSlug || upToken == null || downToken == null || upToken === '' || downToken === '') {
    return {
      roundSlug: roundSlug || String(snapshot?.roundSlug ?? 'unknown'),
      status: STATUS.MISSING_TOKENS,
      snapshot,
      error: 'snapshot missing tokenIds.UP / tokenIds.DOWN',
    };
  }

  let upShares;
  let downShares;
  try {
    upShares = await getShares(String(upToken));
    downShares = await getShares(String(downToken));
  } catch (err) {
    return {
      roundSlug,
      status: STATUS.FETCH_ERROR,
      snapshot,
      error: err?.message ?? String(err),
    };
  }

  if (!Number.isFinite(upShares) || !Number.isFinite(downShares) || upShares < 0 || downShares < 0) {
    return {
      roundSlug,
      status: STATUS.FETCH_ERROR,
      snapshot,
      venue: { upShares, downShares },
      error: `non-finite venue shares UP=${upShares} DOWN=${downShares}`,
    };
  }

  const expectedUp = finiteShares(snapshot.upShares);
  const expectedDown = finiteShares(snapshot.downShares);
  if (
    sharesMatch(upShares, expectedUp, epsilon) &&
    sharesMatch(downShares, expectedDown, epsilon)
  ) {
    return {
      roundSlug,
      status: STATUS.VERIFIED,
      snapshot,
      venue: { upShares, downShares },
    };
  }

  return {
    roundSlug,
    status: STATUS.MISMATCH,
    snapshot,
    venue: { upShares, downShares },
    error:
      `venue UP=${upShares} DOWN=${downShares} vs snapshot ` +
      `UP=${expectedUp} DOWN=${expectedDown}`,
  };
}

/**
 * @param {Iterable<object>|Map|object[]} pending
 * @param {(tokenId: string) => Promise<number>} getShares
 * @param {{ epsilon?: number }} [opts]
 */
export async function reconcilePendingSettlements(pending, getShares, opts = {}) {
  const epsilon = opts.epsilon ?? SHARE_EPSILON;
  const snapshots = [];
  if (pending && typeof pending.entries === 'function') {
    for (const [, snapshot] of pending.entries()) {
      snapshots.push(snapshot);
    }
  } else {
    for (const snapshot of pending ?? []) {
      snapshots.push(snapshot);
    }
  }

  const results = [];
  for (const snapshot of snapshots) {
    // Sequential: rate limiter and clearer failure attribution per round.
    // eslint-disable-next-line no-await-in-loop
    results.push(await reconcilePendingSnapshot(snapshot, getShares, epsilon));
  }

  const verified = results.filter((r) => r.status === STATUS.VERIFIED);
  const failed = results.filter((r) => r.status !== STATUS.VERIFIED);
  return {
    ok: failed.length === 0,
    results,
    verified,
    failed,
  };
}

export { STATUS as RECONCILE_STATUS };
