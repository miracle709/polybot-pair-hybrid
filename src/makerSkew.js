/** Pure, gated maker-skew recommendation. It never mutates V2 rungs. */
export function signalInformedMakerSkew({ snapshot, prediction, params }) {
  if (!params?.SIGNAL_MAKER_SKEW_ENABLED) {
    return Object.freeze({ enabled: false, upMils: 0, downMils: 0, sizeTiltFraction: 0, reasons: ['disabled'] });
  }
  if (!snapshot?.valid || !prediction?.valid || !prediction.calibrated) {
    return Object.freeze({ enabled: false, upMils: 0, downMils: 0, sizeTiltFraction: 0, reasons: ['invalid_or_uncalibrated'] });
  }
  const edge = prediction.pUp - Number(snapshot.upMid);
  const maxMils = Math.max(0, Number(params.MAX_SIGNAL_SKEW_MILS ?? 0));
  const maxSize = Math.max(0, Number(params.MAX_SIGNAL_SIZE_TILT_FRACTION ?? 0));
  const scaled = Math.max(-1, Math.min(1, edge / 0.05));
  return Object.freeze({
    enabled: true,
    upMils: Math.round(maxMils * scaled),
    downMils: -Math.round(maxMils * scaled),
    sizeTiltFraction: maxSize * scaled,
    reasons: Object.freeze([]),
  });
}

