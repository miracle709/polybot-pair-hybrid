function roundId(event) {
  return event?.rid ?? event?.round_slug ?? null;
}

function isCausalSnapshot(snapshot) {
  const decision = Number(snapshot?.decisionTimeMs);
  if (!Number.isFinite(decision)) return false;
  for (const [name, raw] of Object.entries(snapshot.sourceTimestamps ?? {})) {
    if (raw == null) continue;
    const timestamp = Number(raw);
    if (!Number.isFinite(timestamp) || timestamp > decision) return false;
    if (name.endsWith('ArrivalTimeMs') && timestamp > decision) return false;
  }
  return true;
}

/**
 * Join live JSONL records into labeled research rows. Future settlement and
 * execution data is namespaced under `label`/`observations`; model features
 * come only from the causal SignalSnapshot object.
 */
export function buildDecisionDataset(events, { requireWinner = true } = {}) {
  const predictions = new Map();
  const candidates = new Map();
  const selections = new Map();
  const shadows = new Map();
  const winners = new Map();
  const fills = new Map();
  const markouts = new Map();
  const pairCompletions = new Map();
  const snapshots = [];
  const pushRound = (map, rid, value) => {
    if (!rid) return;
    const values = map.get(rid) ?? [];
    values.push(value);
    map.set(rid, values);
  };

  for (const event of events ?? []) {
    const rid = roundId(event);
    switch (event?.type) {
      case 'signal_snapshot':
        snapshots.push(event.snapshot);
        break;
      case 'probability_prediction':
        predictions.set(event.snapshot_id, event);
        break;
      case 'action_candidates':
        candidates.set(event.snapshot_id, event.candidates ?? []);
        break;
      case 'action_selected':
        selections.set(event.snapshot_id, event.candidate ?? null);
        break;
      case 'v3_shadow_decision':
        shadows.set(event.snapshot_id, event);
        break;
      case 'ROUND_RESULT':
        winners.set(rid, String(event.winner ?? event.outcome ?? '').toUpperCase());
        break;
      case 'WALLET_FILL':
        pushRound(fills, rid, event);
        break;
      case 'MAKER_MARKOUT':
        pushRound(markouts, rid, event);
        break;
      case 'pair_completion_observation':
        pushRound(pairCompletions, rid, event.observation);
        break;
      default:
        break;
    }
  }

  const rows = [];
  const rejected = [];
  for (const snapshot of snapshots) {
    const rid = snapshot.roundId;
    if (!isCausalSnapshot(snapshot)) {
      rejected.push({ snapshotId: snapshot.snapshotId, reason: 'look_ahead_timestamp' });
      continue;
    }
    const winner = winners.get(rid) ?? null;
    if (requireWinner && winner !== 'UP' && winner !== 'DOWN') {
      rejected.push({ snapshotId: snapshot.snapshotId, reason: 'winner_missing' });
      continue;
    }
    const prediction = predictions.get(snapshot.snapshotId) ?? null;
    const shadow = shadows.get(snapshot.snapshotId) ?? null;
    const roundFills = fills.get(rid) ?? [];
    const afterDecision = roundFills.filter(
      (fill) => Number(fill.t ?? Number(fill.ts) * 1000) >= snapshot.decisionTimeMs
    );
    const executionObservations = {};
    for (const leg of ['UP', 'DOWN']) {
      const fill = afterDecision.find((candidate) => candidate.leg === leg);
      if (!fill) continue;
      const shares = Number(fill.shares ?? fill.sh);
      const price = Number(fill.price ?? Number(fill.p) / 1000);
      const feeUsd = Number(fill.fee ?? 0);
      const decisionAsk = Number(
        leg === 'UP' ? snapshot.upBestAsk : snapshot.downBestAsk
      );
      executionObservations[leg] = Object.freeze({
        timestampMs: Number(fill.t ?? Number(fill.ts) * 1000),
        role: fill.role ?? null,
        price,
        shares,
        feeUsd,
        feeUsdPerShare: shares > 0 ? feeUsd / shares : 0,
        slippageUsdPerShare:
          Number.isFinite(decisionAsk) && Number.isFinite(price)
            ? price - decisionAsk
            : null,
        orderId: fill.oid ?? null,
      });
    }
    rows.push(Object.freeze({
      roundId: rid,
      decisionTimestampMs: snapshot.decisionTimeMs,
      sourceTimestamps: snapshot.sourceTimestamps,
      features: snapshot,
      marketMidpoint: snapshot.upMid,
      eventualWinner: winner,
      prediction: prediction == null ? null : Object.freeze({
        pUp: prediction.p_up,
        lower: prediction.lower,
        upper: prediction.upper,
        modelVersion: prediction.model_version,
        calibrated: prediction.calibrated,
        valid: prediction.valid,
      }),
      candidates: Object.freeze(candidates.get(snapshot.snapshotId) ?? []),
      selectedAction: selections.get(snapshot.snapshotId) ?? null,
      actualV2Action: shadow?.actual_v2_action ?? null,
      executionObservations: Object.freeze(executionObservations),
      observations: Object.freeze({
        fills: Object.freeze([...roundFills]),
        markouts: Object.freeze([...(markouts.get(rid) ?? [])]),
        pairCompletions: Object.freeze([...(pairCompletions.get(rid) ?? [])]),
      }),
    }));
  }
  rows.sort((a, b) => a.decisionTimestampMs - b.decisionTimestampMs);
  return Object.freeze({
    rows: Object.freeze(rows),
    rejected: Object.freeze(rejected),
  });
}

export function parseJsonLines(text) {
  const events = [];
  const errors = [];
  for (const [index, line] of String(text ?? '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      errors.push({ line: index + 1, error: error.message });
    }
  }
  return { events, errors };
}
