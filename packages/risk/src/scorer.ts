import { FEATURE_COUNT, FEATURE_NAMES, extract } from './features.js';
import type { FeatureName, FeatureVector, RawSignals } from './features.js';

/**
 * Gradient-boosted decision stumps.
 *
 * Depth-1 trees, logistic loss, trained by the routine below. A stump ensemble
 * is chosen over something deeper for three reasons that matter more here than
 * raw accuracy:
 *
 *   - Inference is a handful of comparisons, so the p99 budget is met by
 *     construction rather than by tuning.
 *   - Every stump is one feature and one threshold, so a decision can be
 *     explained to a fan who was blocked and to the operator who has to decide
 *     whether to override it.
 *   - It cannot silently learn an interaction with a protected proxy the way a
 *     deep model can.
 *
 * ⚠ The shipped model is trained on SYNTHETIC traffic generated in this repo. It
 * demonstrates that the pipeline separates scripted from human behaviour; it says
 * nothing about real adversaries. Before an onsale it must be retrained on
 * labelled production traffic, and it must be retrained continuously — a scalper
 * adapts weekly, so a model refreshed quarterly has already lost.
 */

export interface Stump {
  readonly feature: number;
  readonly threshold: number;
  /** Added to the log-odds when the feature is at or below the threshold. */
  readonly left: number;
  /** Added when it is above. */
  readonly right: number;
}

export interface Model {
  readonly version: string;
  readonly bias: number;
  readonly stumps: readonly Stump[];
  /** Feature order this model was fit against. Guards a silent reorder. */
  readonly featureNames: readonly string[];
}

export type RiskVerdict = 'allow' | 'challenge' | 'throttle' | 'block';

export interface ScoreResult {
  /** Probability this request is automated, in [0, 1]. */
  readonly score: number;
  readonly verdict: RiskVerdict;
  /** The stumps that moved the score most, for review and for an appeal. */
  readonly topReasons: ReadonlyArray<{ feature: FeatureName; contribution: number }>;
}

/**
 * Where the four verdicts start.
 *
 * The gap between `challenge` and `block` is deliberate and wide. A challenge
 * costs a real fan a few seconds; a block costs them the show. When the model is
 * unsure the correct action is friction, not refusal — the same principle as the
 * gate's review band.
 */
export interface Bands {
  readonly challenge: number;
  readonly throttle: number;
  readonly block: number;
}

export const DEFAULT_BANDS: Bands = Object.freeze({ challenge: 0.5, throttle: 0.75, block: 0.9 });

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function verdictFor(score: number, bands: Bands = DEFAULT_BANDS): RiskVerdict {
  if (score >= bands.block) return 'block';
  if (score >= bands.throttle) return 'throttle';
  if (score >= bands.challenge) return 'challenge';
  return 'allow';
}

export class Scorer {
  constructor(
    private readonly model: Model,
    private readonly bands: Bands = DEFAULT_BANDS,
  ) {
    if (model.featureNames.length !== FEATURE_COUNT) {
      throw new Error(
        `model was fit against ${model.featureNames.length} features but the extractor produces ${FEATURE_COUNT}`,
      );
    }
    model.featureNames.forEach((name, i) => {
      if (name !== FEATURE_NAMES[i]) {
        throw new Error(
          `feature order changed: model expects '${name}' at index ${i}, extractor produces '${FEATURE_NAMES[i]}'. Every coefficient after this point is being applied to the wrong number.`,
        );
      }
    });
  }

  /** The hot path. A few dozen comparisons and one exp. */
  scoreVector(v: FeatureVector): number {
    let logOdds = this.model.bias;
    for (const s of this.model.stumps) {
      logOdds += (v[s.feature] ?? 0) <= s.threshold ? s.left : s.right;
    }
    return sigmoid(logOdds);
  }

  score(signals: RawSignals): ScoreResult {
    const v = extract(signals);
    const score = this.scoreVector(v);

    // Contributions, summed per feature, so the explanation names features
    // rather than listing forty anonymous stumps.
    const byFeature = new Map<number, number>();
    for (const s of this.model.stumps) {
      const contribution = (v[s.feature] ?? 0) <= s.threshold ? s.left : s.right;
      byFeature.set(s.feature, (byFeature.get(s.feature) ?? 0) + contribution);
    }

    const topReasons = [...byFeature.entries()]
      .map(([feature, contribution]) => ({ feature: FEATURE_NAMES[feature] as FeatureName, contribution }))
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 3);

    return { score, verdict: verdictFor(score, this.bands), topReasons };
  }
}

// ─── training ────────────────────────────────────────────────────────────────

export interface TrainingRow {
  readonly features: FeatureVector;
  /** 1 for automated, 0 for human. */
  readonly label: number;
}

export interface TrainOptions {
  readonly rounds?: number;
  readonly learningRate?: number;
  readonly version?: string;
}

/**
 * Fit an ensemble of stumps by gradient boosting on logistic loss.
 *
 * Each round finds the single (feature, threshold) split that best fits the
 * current residuals, then adds it with a shrunk step. Standard, small, and
 * entirely legible — which matters, because somebody will eventually have to
 * defend a blocked purchase in front of a person who is angry about it.
 */
export function train(rows: readonly TrainingRow[], options: TrainOptions = {}): Model {
  const rounds = options.rounds ?? 60;
  const learningRate = options.learningRate ?? 0.3;
  if (rows.length === 0) throw new Error('cannot train on an empty set');

  const positives = rows.reduce((n, r) => n + r.label, 0);
  const base = Math.min(0.999, Math.max(0.001, positives / rows.length));
  let bias = Math.log(base / (1 - base));

  const logOdds = new Float64Array(rows.length).fill(bias);
  const stumps: Stump[] = [];

  // Candidate thresholds per feature: quantiles of the observed values, so the
  // splits sit where the data actually is rather than on an arbitrary grid.
  const candidates: number[][] = [];
  for (let f = 0; f < FEATURE_COUNT; f += 1) {
    const values = rows.map((r) => r.features[f] ?? 0).sort((a, b) => a - b);
    const qs: number[] = [];
    for (let q = 1; q <= 15; q += 1) {
      const value = values[Math.floor((values.length * q) / 16)] ?? 0;
      if (!qs.includes(value)) qs.push(value);
    }
    candidates.push(qs);
  }

  for (let round = 0; round < rounds; round += 1) {
    // Newton step on logistic loss: gradient and hessian per row.
    const gradient = new Float64Array(rows.length);
    const hessian = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
      const p = sigmoid(logOdds[i] as number);
      gradient[i] = p - (rows[i] as TrainingRow).label;
      hessian[i] = Math.max(1e-6, p * (1 - p));
    }

    let best: (Stump & { gain: number }) | undefined;

    for (let f = 0; f < FEATURE_COUNT; f += 1) {
      for (const threshold of candidates[f] as number[]) {
        let gl = 0;
        let hl = 0;
        let gr = 0;
        let hr = 0;
        for (let i = 0; i < rows.length; i += 1) {
          if (((rows[i] as TrainingRow).features[f] ?? 0) <= threshold) {
            gl += gradient[i] as number;
            hl += hessian[i] as number;
          } else {
            gr += gradient[i] as number;
            hr += hessian[i] as number;
          }
        }
        if (hl < 1e-6 || hr < 1e-6) continue;
        const gain = (gl * gl) / hl + (gr * gr) / hr;
        if (!best || gain > best.gain) {
          best = {
            feature: f,
            threshold,
            left: -(gl / hl) * learningRate,
            right: -(gr / hr) * learningRate,
            gain,
          };
        }
      }
    }

    if (!best) break;
    const { gain: _gain, ...stump } = best;
    stumps.push(stump);

    for (let i = 0; i < rows.length; i += 1) {
      logOdds[i] =
        (logOdds[i] as number) +
        (((rows[i] as TrainingRow).features[stump.feature] ?? 0) <= stump.threshold ? stump.left : stump.right);
    }
  }

  // Fold nothing back into the bias: it was set from the base rate and the
  // stumps carry the rest, which keeps each stump's contribution interpretable.
  bias = Math.log(base / (1 - base));

  return {
    version: options.version ?? `stumps-${rounds}-${new Date().toISOString().slice(0, 10)}`,
    bias,
    stumps,
    featureNames: [...FEATURE_NAMES],
  };
}

export interface EvalResult {
  readonly blockedBots: number;
  readonly totalBots: number;
  readonly blockedHumans: number;
  readonly totalHumans: number;
  readonly botBlockRate: number;
  readonly humanFalseBlockRate: number;
  readonly humanFrictionRate: number;
}

/**
 * Evaluate against held-out traffic.
 *
 * Reports two numbers that pull against each other. The bot block rate is the
 * product claim; the human false-block rate is the cost of it, and it is the one
 * that ends up on social media.
 */
export function evaluate(
  scorer: Scorer,
  rows: ReadonlyArray<{ features: FeatureVector; label: number }>,
  bands: Bands = DEFAULT_BANDS,
): EvalResult {
  let blockedBots = 0;
  let totalBots = 0;
  let blockedHumans = 0;
  let totalHumans = 0;
  let frictionHumans = 0;

  for (const row of rows) {
    const score = scorer.scoreVector(row.features);
    const verdict = verdictFor(score, bands);
    if (row.label === 1) {
      totalBots += 1;
      if (verdict === 'block' || verdict === 'throttle') blockedBots += 1;
    } else {
      totalHumans += 1;
      if (verdict === 'block') blockedHumans += 1;
      if (verdict !== 'allow') frictionHumans += 1;
    }
  }

  return {
    blockedBots,
    totalBots,
    blockedHumans,
    totalHumans,
    botBlockRate: totalBots === 0 ? 0 : blockedBots / totalBots,
    humanFalseBlockRate: totalHumans === 0 ? 0 : blockedHumans / totalHumans,
    humanFrictionRate: totalHumans === 0 ? 0 : frictionHumans / totalHumans,
  };
}

/**
 * Choose the verdict bands from a false-positive budget.
 *
 * The default bands are round numbers, and round numbers are the wrong way to
 * set an operating point: 0.9 means nothing until you know what fraction of real
 * fans score above it. This picks each threshold from the quantiles of the
 * HUMAN score distribution, so the bands are stated in the currency that
 * actually matters — how many real people get stopped.
 *
 * `blockRate: 0.005` means "block the top 0.5% of human-looking scores, and
 * whatever bots land above that line come along for free". That is a decision an
 * operations lead can make and defend. "Threshold 0.9" is not.
 */
export function calibrateBands(
  scorer: Scorer,
  humanFeatures: readonly FeatureVector[],
  targets: { blockRate: number; throttleRate: number; challengeRate: number },
): Bands {
  if (humanFeatures.length === 0) return DEFAULT_BANDS;

  const scores = humanFeatures.map((f) => scorer.scoreVector(f)).sort((a, b) => a - b);
  const at = (rate: number) => {
    const index = Math.min(scores.length - 1, Math.floor(scores.length * (1 - rate)));
    // Nudge above the quantile so the fan sitting exactly on it is not caught.
    return Math.min(1, (scores[index] ?? 1) + 1e-9);
  };

  const block = at(targets.blockRate);
  const throttle = Math.min(block, at(targets.throttleRate));
  const challenge = Math.min(throttle, at(targets.challengeRate));
  return { challenge, throttle, block };
}
