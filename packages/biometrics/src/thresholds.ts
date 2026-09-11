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
 * ⚠ These values are measured, but on a small sample. They come from
 * `npm run face:calibrate`, which scores every pair of 17 photographs of five
 * people through the browser matcher in @rexell/ui — the same code the fan app
 * enrols with and the gate probes with. They are no longer the placeholders
 * that were set against a synthetic matcher that recognised nobody, and which
 * would have admitted essentially every stranger once a real network was
 * plugged in: at the old match threshold of 0.78 the measured false-accept rate
 * on that sample was 100%.
 *
 * What is still missing is scale. Five people produce four impostors per face;
 * an event gallery has twelve thousand, and the highest impostor score over
 * twelve thousand candidates is much higher than the highest over four. That is
 * the whole difficulty of 1:N and it cannot be measured on a sample this size.
 * Before any real event these must be re-measured on the population and the
 * cameras that will be used, at the operating point the roadmap specifies: FRR
 * under 1.5% and FAR under 1 in 100,000 within a gallery of roughly 12,000.
 */
export interface Thresholds {
  /** At or above: admit. */
  readonly match: number;
  /** At or above (but below match): send to the resolution desk. */
  readonly review: number;
  /** At or above, for a DIFFERENT identity during enrolment: raise a dedupe flag. */
  readonly dedupe: number;
}

/**
 * Where these three came from.
 *
 * Measured on the 17 real descriptors in `test/real-faces.json`, which is the
 * shipped matcher's own output. Two photographs of the same person scored
 * 0.664 at worst; two photographs of different people scored 0.543 at best.
 * The decision band lives in that gap, and `real-faces.test.ts` fails if a
 * change to either end closes it.
 *
 * `match` at 0.60 sits between the two with a little more room above the
 * impostor ceiling than below the genuine floor. The lean is deliberate: a
 * stranger admitted on somebody else's ticket is the failure with no remedy,
 * while the cost of pitching `match` high lands in the review band, where it
 * costs a real ticket-holder ninety seconds at a desk rather than their
 * evening.
 *
 * `review` at 0.50 is below the closest impostor pair, on purpose. Those two
 * are the most alike strangers in the sample, and sending them to a human is
 * the right outcome — the review band is not a weaker admission, it is a
 * referral. What must never happen is an impostor at or above `match`, and
 * that is the assertion the test actually enforces.
 */
export const PROTOTYPE_THRESHOLDS: Thresholds = Object.freeze({
  match: 0.6,
  review: 0.5,
  // Deliberately looser than `match`. Dedupe is a review queue, not a gate, so
  // it should over-flag rather than miss a farm — a false flag costs an operator
  // a minute, a missed one lets sixty accounts through an onsale.
  dedupe: 0.55,
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
