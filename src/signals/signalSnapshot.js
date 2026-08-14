function freezeValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeValue));
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = freezeValue(item);
    return Object.freeze(copy);
  }
  return value;
}

/** Immutable, causal decision-time feature record. */
export function createSignalSnapshot(fields) {
  if (!fields?.snapshotId) throw new Error('SignalSnapshot.snapshotId required');
  const decisionTimeMs = Number(fields.decisionTimeMs);
  if (!Number.isFinite(decisionTimeMs) || decisionTimeMs < 0) {
    throw new RangeError('SignalSnapshot.decisionTimeMs must be non-negative');
  }
  const invalidReasons = Object.freeze([...(fields.invalidReasons ?? [])]);
  return Object.freeze({
    ...fields,
    decisionTimeMs,
    invalidReasons,
    valid: Boolean(fields.valid) && invalidReasons.length === 0,
    sourceTimestamps: freezeValue(fields.sourceTimestamps ?? {}),
    depthFeatures: freezeValue(fields.depthFeatures ?? null),
    spread: freezeValue(fields.spread ?? null),
  });
}

