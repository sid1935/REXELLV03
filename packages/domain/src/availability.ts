/**
 * How much is left, said coarsely.
 *
 * A fan needs to know whether to hurry. An organizer's exact sales curve is
 * commercially sensitive and they never agreed to publish it — a competitor
 * polling `sold` every hour reconstructs their entire onsale, and so does a
 * journalist writing "tickets barely moving for X".
 *
 * So the public surface reports a band and the authenticated one reports
 * numbers. This is the single definition of that band, so the two cannot drift
 * into disagreeing about what "limited" means.
 */

export type Availability = 'available' | 'limited' | 'last_few' | 'sold_out';

export interface AvailabilityInput {
  readonly allocation: number;
  readonly sold: number;
  readonly held: number;
}

/**
 * Held inventory counts as unavailable.
 *
 * Somebody else's open cart is not a ticket you can buy, and showing it as
 * available produces a `SOLD_OUT` at checkout, which is worse than showing a
 * smaller number in the first place.
 */
export function remainingOf({ allocation, sold, held }: AvailabilityInput): number {
  return Math.max(0, allocation - sold - held);
}

export function availabilityOf(input: AvailabilityInput): Availability {
  const remaining = remainingOf(input);
  if (remaining <= 0) return 'sold_out';

  /**
   * Absolute floors as well as proportional ones — twenty left is "last few" at
   * a stadium and at a club, even though the percentages are nothing alike.
   *
   * But the floors are then capped against the allocation, and that cap is the
   * important half. Without it a thirty-ticket event reads "selling fast" with
   * every ticket still available, because the sixty-ticket floor is larger than
   * the whole event. Manufactured urgency is a dark pattern anywhere; in a
   * product whose pitch is that ticketing can be trusted, it is self-defeating.
   */
  const lastFew = Math.min(Math.max(20, Math.floor(input.allocation * 0.02)), Math.floor(input.allocation * 0.1));
  if (remaining <= lastFew) return 'last_few';

  const limited = Math.min(Math.max(60, Math.floor(input.allocation * 0.1)), Math.floor(input.allocation * 0.33));
  if (remaining <= limited) return 'limited';

  return 'available';
}

/** Wording for a fan, not a status code. */
export const AVAILABILITY_LABEL: Readonly<Record<Availability, string>> = Object.freeze({
  available: 'On sale',
  limited: 'Selling fast',
  last_few: 'Last few',
  sold_out: 'Sold out',
});

/**
 * Whether an event should appear in a public catalogue at all.
 *
 * Sold out stays listed — a fan wants to know it exists and that resale might
 * open. Closed does not: an event nobody can buy into is noise, and listing it
 * invites the "why can't I buy this" support ticket.
 */
export function isDiscoverable(event: {
  salesOpenAt: number;
  salesCloseAt: number;
  endsAt: number;
}, now: number): boolean {
  return now >= event.salesOpenAt && now < event.salesCloseAt && now < event.endsAt;
}
