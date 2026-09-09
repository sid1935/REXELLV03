/**
 * The domain never reads a clock. Every function that cares about time takes
 * `now` as an argument.
 *
 * This is not purity for its own sake. A gate scanner that has been offline for
 * forty minutes, a resale window closing, and a cooldown expiring are all things
 * that have to be testable at an exact instant, and a scanner's own clock is not
 * necessarily correct — the caller decides which clock is authoritative.
 */

declare const EpochBrand: unique symbol;

/** Milliseconds since the Unix epoch, UTC. */
export type EpochMs = number & { readonly [EpochBrand]: 'EpochMs' };

export function epochMs(value: number): EpochMs {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`EpochMs must be an integer millisecond timestamp, got ${value}`);
  }
  return value as EpochMs;
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function plus(t: EpochMs, ms: number): EpochMs {
  return epochMs(t + ms);
}

export function within(t: EpochMs, from: EpochMs, until: EpochMs): boolean {
  return t >= from && t < until;
}
