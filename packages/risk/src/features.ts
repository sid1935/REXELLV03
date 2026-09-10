/**
 * Feature extraction.
 *
 * There is exactly one transform in this file and both paths call it: the inline
 * scorer at onsale, and the offline job that builds training data. That is not
 * tidiness — it is the whole point of a feature store.
 *
 * The failure it prevents is training/serving skew: a model trained on features
 * computed one way and served features computed another way. It fails silently,
 * it looks like a mysterious accuracy drop in production, and it is the single
 * most common way an ML system quietly stops working. `features.test.ts` asserts
 * the two paths agree byte for byte over the same events.
 */

/** What the edge actually observes. Raw, per-request, no interpretation. */
export interface RawSignals {
  readonly sessionId: string;
  readonly identityId?: string;
  readonly deviceFingerprint: string;
  readonly asn: number;
  readonly asnIsDatacenter: boolean;
  readonly deviceAttested: boolean;
  /** Milliseconds between page load and the first meaningful action. */
  readonly dwellMs: number;
  /** Gaps between successive actions this session, in order. */
  readonly interActionMs: readonly number[];
  /** Direction changes per 100px of pointer travel. Zero for a headless client. */
  readonly pointerTurnsPer100px: number;
  /** Whether any pointer or touch movement was observed at all. */
  readonly pointerObserved: boolean;
  readonly accountAgeHours: number;
  readonly requestsLastMinute: number;
  /** Distinct accounts seen on this device fingerprint, from the offline graph. */
  readonly accountsOnDevice: number;
  /** Distinct accounts sharing this payment instrument. */
  readonly accountsOnCard: number;
  /** Time from seat map render to selection. Humans deliberate; scripts do not. */
  readonly seatSelectionMs: number;
}

/**
 * The model's input. Order is fixed and load-bearing: the coefficient at index
 * `i` belongs to the feature at index `i`, and a reorder silently reinterprets
 * every weight.
 */
export const FEATURE_NAMES = [
  'logDwell',
  'interActionCv',
  'interActionMin',
  'pointerEntropy',
  'noPointer',
  'notAttested',
  'datacenterAsn',
  'logAccountAge',
  'logVelocity',
  'logAccountsOnDevice',
  'logAccountsOnCard',
  'logSeatSelection',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export const FEATURE_COUNT = FEATURE_NAMES.length;

export type FeatureVector = Float64Array;

const log1p = (x: number) => Math.log1p(Math.max(0, x));

/**
 * Coefficient of variation of the gaps between actions.
 *
 * The signal that survives the most effort to defeat. A human's rhythm is
 * irregular — reading, hesitating, being interrupted — so the spread of their
 * gaps is comparable to the mean. A script's is not, and adding jitter to a
 * script raises the CV towards human only by making the script slower, which is
 * exactly the trade we want to force.
 */
export function intervalCv(intervals: readonly number[]): number {
  if (intervals.length < 2) return 0;
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (mean <= 0) return 0;
  const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Extract features. Pure, total, and the only place raw signals become numbers.
 *
 * Every branch here is deterministic and every output is finite — a NaN reaching
 * the scorer would produce a score of NaN, which compares false against every
 * threshold and therefore silently admits.
 */
export function extract(s: RawSignals): FeatureVector {
  const v = new Float64Array(FEATURE_COUNT);
  const intervals = s.interActionMs;

  v[0] = log1p(s.dwellMs);
  v[1] = intervalCv(intervals);
  v[2] = log1p(intervals.length > 0 ? Math.min(...intervals) : 0);
  v[3] = s.pointerTurnsPer100px;
  v[4] = s.pointerObserved ? 0 : 1;
  v[5] = s.deviceAttested ? 0 : 1;
  v[6] = s.asnIsDatacenter ? 1 : 0;
  v[7] = log1p(s.accountAgeHours);
  v[8] = log1p(s.requestsLastMinute);
  v[9] = log1p(s.accountsOnDevice);
  v[10] = log1p(s.accountsOnCard);
  v[11] = log1p(s.seatSelectionMs);

  for (let i = 0; i < FEATURE_COUNT; i += 1) {
    if (!Number.isFinite(v[i] as number)) v[i] = 0;
  }
  return v;
}

/** Named form, for a review console and for debugging a score after the fact. */
export function explain(v: FeatureVector): Record<FeatureName, number> {
  const out = {} as Record<FeatureName, number>;
  FEATURE_NAMES.forEach((name, i) => {
    out[name] = v[i] ?? 0;
  });
  return out;
}
