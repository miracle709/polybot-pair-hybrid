export class PairCompletionModel {
  // eslint-disable-next-line no-unused-vars
  predict(firstFillState) {
    throw new Error('PairCompletionModel.predict not implemented');
  }
}

/** Safe default: telemetry exists, but no probability is trusted for trading. */
export class UnvalidatedPairCompletionModel extends PairCompletionModel {
  constructor({ horizonsSeconds = [5, 15, 30, 60, 'remaining_round'] } = {}) {
    super();
    this.horizonsSeconds = Object.freeze([...horizonsSeconds]);
  }
  predict() {
    return Object.freeze({
      modelVersion: 'pair-completion-unvalidated-v1',
      probabilities: Object.freeze(Object.fromEntries(
        this.horizonsSeconds.map((horizon) => [String(horizon), null])
      )),
      calibrated: false,
      valid: false,
      reasons: Object.freeze(['collect_and_walk_forward_validate_first']),
    });
  }
}

/** Applies a separately validated offline hazard artifact without fitting live. */
export class EmpiricalPairCompletionModel extends PairCompletionModel {
  constructor({ artifact, minimumSamples = 500 } = {}) {
    super();
    this.artifact = artifact ?? null;
    this.minimumSamples = minimumSamples;
  }
  predict(firstFillState) {
    const artifact = this.artifact;
    if (!artifact) return new UnvalidatedPairCompletionModel().predict();
    const validation = artifact.validation ?? {};
    const valid =
      validation.walkForward === true &&
      validation.calibrated === true &&
      Number(validation.sampleCount) >= this.minimumSamples;
    const groupKey = `${firstFillState?.firstLeg ?? 'ANY'}:${firstFillState?.regime ?? 'ANY'}`;
    const probabilities = artifact.groups?.[groupKey] ?? artifact.groups?.ANY ?? {};
    const cleaned = {};
    for (const [horizon, probability] of Object.entries(probabilities)) {
      const p = Number(probability);
      cleaned[horizon] = Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
    }
    return Object.freeze({
      modelVersion: artifact.modelVersion ?? 'pair-completion-artifact',
      probabilities: Object.freeze(cleaned),
      calibrated: valid,
      valid: valid && Object.values(cleaned).some((value) => value != null),
      reasons: Object.freeze(valid ? [] : ['hazard_artifact_not_validated']),
    });
  }
}

