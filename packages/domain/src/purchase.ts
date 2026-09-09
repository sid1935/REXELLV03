import type { EventDef, TicketTier } from './event.js';
import type { IdentityId } from './ids.js';
import type { EpochMs } from './time.js';
import type { Verdict } from './result.js';
import { ok, reject } from './result.js';

/** What the risk layer decided about this request. See architecture §08. */
export type RiskVerdict = 'allow' | 'challenge' | 'throttle' | 'block';

export interface PurchaserContext {
  readonly identityId: IdentityId;
  /** Biometric enrolment finished. Without it the ticket cannot be bound to anyone. */
  readonly enrolled: boolean;
  readonly blocked: boolean;
  /** Tickets this identity already holds for THIS event, in any valid state. */
  readonly ticketsHeldForEvent: number;
  readonly ageYears?: number;
  readonly riskVerdict: RiskVerdict;
}

export interface PurchaseRequest {
  readonly tier: TicketTier;
  readonly quantity: number;
  readonly now: EpochMs;
}

export interface TierAvailability {
  readonly sold: number;
  readonly held: number;
}

/**
 * Ordering matters here and it is not arbitrary.
 *
 * Cheap, request-scoped checks come before anything that touches inventory, so a
 * bot farm never holds seats it was never going to be allowed to buy. The risk
 * verdict is checked first of all, for the same reason (architecture §05).
 */
export function evaluatePurchase(
  event: EventDef,
  request: PurchaseRequest,
  buyer: PurchaserContext,
  availability: TierAvailability,
): Verdict<{ readonly quantity: number }> {
  if (buyer.riskVerdict === 'block') {
    return reject('RISK_BLOCKED', 'This request could not be completed. Please contact support.', {
      identityId: buyer.identityId,
    });
  }

  if (buyer.blocked) {
    return reject('IDENTITY_BLOCKED', 'This account cannot purchase tickets. Please contact support.');
  }

  if (!buyer.enrolled) {
    return reject(
      'NOT_ENROLLED',
      'Finish setting up your ReXell ID before buying. It takes about a minute and it is what gets you through the gate.',
    );
  }

  if (request.now < event.salesOpenAt) {
    return reject('SALE_NOT_OPEN', 'Tickets are not on sale yet.', { opensAt: event.salesOpenAt });
  }
  if (request.now >= event.salesCloseAt) {
    return reject('SALE_CLOSED', 'Sales for this event have closed.', { closedAt: event.salesCloseAt });
  }

  if (event.minimumAge !== undefined) {
    if (buyer.ageYears === undefined) {
      return reject('UNDER_MINIMUM_AGE', `This event is ${event.minimumAge}+ and we could not verify your age.`, {
        minimumAge: event.minimumAge,
      });
    }
    if (buyer.ageYears < event.minimumAge) {
      return reject('UNDER_MINIMUM_AGE', `This event is restricted to ages ${event.minimumAge} and over.`, {
        minimumAge: event.minimumAge,
      });
    }
  }

  if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
    return reject('PURCHASE_LIMIT_REACHED', 'Choose at least one ticket.', { quantity: request.quantity });
  }

  const wouldHold = buyer.ticketsHeldForEvent + request.quantity;
  if (wouldHold > event.maxTicketsPerIdentity) {
    const remaining = Math.max(0, event.maxTicketsPerIdentity - buyer.ticketsHeldForEvent);
    return reject(
      'PURCHASE_LIMIT_REACHED',
      remaining === 0
        ? `You already have the maximum of ${event.maxTicketsPerIdentity} tickets for this event.`
        : `You can buy ${remaining} more ticket${remaining === 1 ? '' : 's'} for this event.`,
      { limit: event.maxTicketsPerIdentity, alreadyHeld: buyer.ticketsHeldForEvent, remaining },
    );
  }

  const remainingInTier = request.tier.allocation - availability.sold - availability.held;
  if (remainingInTier < request.quantity) {
    return reject(
      'SOLD_OUT',
      remainingInTier <= 0
        ? `${request.tier.name} is sold out.`
        : `Only ${remainingInTier} ${request.tier.name} ticket${remainingInTier === 1 ? '' : 's'} left.`,
      { remaining: Math.max(0, remainingInTier) },
    );
  }

  return ok({ quantity: request.quantity });
}
