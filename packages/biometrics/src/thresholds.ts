/**
 * Thresholds.
 *
 * Three numbers decide whether a person gets in, and the gap between two of them
 * is the single most important design choice in the gate:
 *
 *     score >= MATCH    admit
 *     score >= REVIEW   fall back to a staffed lane      ← the important band
 *     score <  REVIEW   treat as no match, also fallback
 *
 * A system with one threshold has to choose between admitting strangers and
 * turning away ticket-holders. The review band means an uncertain match costs
 * somebody ninety seconds at a desk instead of their evening.
 *
 * ⚠ These values are prototype placeholders. They are set against the synthetic
 * matcher in this package, NOT against a real ROC curve. Before any real event
 * they must be recalibrated on the licensed SDK's own curve, at the operating
 * point the roadmap specifies: FRR under 1.5% and FAR under 1 in 100,000 within
 * an event-scoped gallery of roughly 12,000.
 */
export interface Thresholds {
  /** At or above: admit. */
  readonly match: number;
  /** At or above (but below match): send to the resolution desk. */
  readonly review: number;
  /** At or above, for a DIFFERENT identity during enrolment: raise a dedupe flag. */
  readonly dedupe: number;
}

export const PROTOTYPE_THRESHOLDS: Thresholds = Object.freeze({
  match: 0.78,
  review: 0.62,
  // Deliberately looser than `match`. Dedupe is a review queue, not a gate, so
  // it should over-flag rather than miss a farm — a false flag costs an operator
  // a minute, a missed one lets sixty accounts through an onsale.
  dedupe: 0.72,
});

export type Band = 'match' | 'review' | 'no_match';

export function band(score: number, t: Thresholds = PROTOTYPE_THRESHOLDS): Band {
  if (score >= t.match) return 'match';
  if (score >= t.review) return 'review';
  return 'no_match';
}

export function validateThresholds(t: Thresholds): void {
  if (!(t.review < t.match)) {
    throw new Error(
      `review threshold ${t.review} must be below match ${t.match}; without a gap there is no fallback band and every uncertain scan becomes a refusal`,
    );
  }
  for (const [name, value] of Object.entries(t)) {
    if (!(value > -1 && value <= 1)) throw new Error(`${name} threshold ${value} is outside the cosine range`);
  }
}
