import type { TicketTier } from './event.js';
import { resaleCeiling, resaleFloor } from './event.js';
import type { IdentityId, ListingId, TicketId } from './ids.js';
import type { Minor } from './money.js';
import { formatMinor } from './money.js';
import type { Ticket } from './ticket.js';
import type { EpochMs } from './time.js';
import type { Verdict } from './result.js';
import { ok, reject } from './result.js';
import type { PurchaserContext } from './purchase.js';

export type ListingState = 'active' | 'sold' | 'cancelled' | 'expired';

export interface Listing {
  readonly id: ListingId;
  readonly ticketId: TicketId;
  readonly sellerIdentityId: IdentityId;
  readonly price: Minor;
  readonly state: ListingState;
  readonly listedAt: EpochMs;
}

export interface SellerContext {
  readonly identityId: IdentityId;
  readonly activeListings: number;
}

/**
 * Can this ticket be listed, at this price, right now?
 *
 * Every branch here has a matching `require` in the ResaleController contract.
 * This function exists so a fan finds out in the UI instead of in a reverted
 * transaction, but it is emphatically *not* the enforcement point — the contract
 * is. Two checks, because the first is an affordance and the second is the rule.
 */
export function evaluateListing(
  ticket: Ticket,
  tier: TicketTier,
  price: Minor,
  seller: SellerContext,
  now: EpochMs,
): Verdict<{ readonly ceiling: Minor; readonly floor: Minor }> {
  const policy = tier.resale;

  if (policy.mode === 'bound') {
    return reject(
      'RESALE_DISABLED',
      'The organizer has turned resale off for this ticket. If you can no longer attend, you can return it for a refund at face value.',
    );
  }

  if (ticket.state !== 'issued') {
    return reject('TICKET_NOT_LISTABLE', `This ticket cannot be listed while it is ${ticket.state}.`, {
      state: ticket.state,
    });
  }

  if (ticket.ownerIdentityId !== seller.identityId) {
    return reject('TICKET_NOT_LISTABLE', 'This ticket does not belong to you.');
  }

  if (now < policy.opensAt) {
    return reject('RESALE_WINDOW_NOT_OPEN', 'Resale for this event has not opened yet.', {
      opensAt: policy.opensAt,
    });
  }
  if (now >= policy.closesAt) {
    return reject(
      'RESALE_WINDOW_CLOSED',
      'Resale for this event has closed. It shuts before doors so the gates can sync.',
      { closedAt: policy.closesAt },
    );
  }

  const cooldownEndsAt = ticket.acquiredAt + policy.cooldownMs;
  if (policy.cooldownMs > 0 && now < cooldownEndsAt) {
    return reject('COOLDOWN_ACTIVE', 'You can list this ticket a little later — there is a short hold after purchase.', {
      cooldownEndsAt,
    });
  }

  if (ticket.resaleCount >= policy.maxResalesPerTicket) {
    return reject('RESALE_LIMIT_REACHED', 'This ticket has already been resold the maximum number of times.', {
      resaleCount: ticket.resaleCount,
      max: policy.maxResalesPerTicket,
    });
  }

  if (seller.activeListings >= policy.maxActiveListingsPerIdentity) {
    return reject(
      'LISTING_LIMIT_REACHED',
      `You can have ${policy.maxActiveListingsPerIdentity} ticket${policy.maxActiveListingsPerIdentity === 1 ? '' : 's'} listed at a time.`,
      { activeListings: seller.activeListings, max: policy.maxActiveListingsPerIdentity },
    );
  }

  const ceiling = resaleCeiling(tier);
  const floor = resaleFloor(tier);

  if (price > ceiling) {
    return reject('PRICE_ABOVE_CEILING', `The organizer has capped resale at ${formatMinor(ceiling, { symbol: '₹' })}.`, {
      ceiling,
      requested: price,
    });
  }
  if (price < floor) {
    return reject('PRICE_BELOW_FLOOR', `Resale price must be at least ${formatMinor(floor, { symbol: '₹' })}.`, {
      floor,
      requested: price,
    });
  }

  return ok({ ceiling, floor });
}

/**
 * Can this buyer take this listing?
 *
 * `expectedPrice` guards against the price changing between the buyer seeing the
 * listing and confirming it — the same problem an exchange solves with a limit
 * order, and the reason a fan should never be charged more than the number they
 * looked at.
 */
export function evaluateListingPurchase(
  listing: Listing,
  tier: TicketTier,
  buyer: PurchaserContext,
  expectedPrice: Minor,
  maxTicketsPerIdentity: number,
  now: EpochMs,
): Verdict<{ readonly price: Minor }> {
  if (listing.state !== 'active') {
    return reject('LISTING_NOT_ACTIVE', 'This ticket has already gone.', { state: listing.state });
  }

  if (listing.sellerIdentityId === buyer.identityId) {
    return reject('CANNOT_BUY_OWN_LISTING', 'You cannot buy your own listing.');
  }

  if (listing.price !== expectedPrice) {
    return reject('PRICE_CHANGED', 'The price changed while you were checking out. Please review it again.', {
      shown: expectedPrice,
      actual: listing.price,
    });
  }

  if (buyer.riskVerdict === 'block') {
    return reject('RISK_BLOCKED', 'This request could not be completed. Please contact support.');
  }
  if (buyer.blocked) {
    return reject('IDENTITY_BLOCKED', 'This account cannot purchase tickets. Please contact support.');
  }
  if (!buyer.enrolled) {
    return reject(
      'NOT_ENROLLED',
      'Finish setting up your ReXell ID before buying. Your face is what gets you through the gate.',
    );
  }

  const policy = tier.resale;
  if (now >= policy.closesAt) {
    return reject('RESALE_WINDOW_CLOSED', 'Resale for this event has closed.', { closedAt: policy.closesAt });
  }

  // A resale still counts against the buyer's per-event ticket limit. Without this
  // check the limit is trivially bypassed by buying on the secondary market
  // instead of the primary one — which is exactly what a farm would do.
  if (buyer.ticketsHeldForEvent + 1 > maxTicketsPerIdentity) {
    return reject('PURCHASE_LIMIT_REACHED', 'You already have the maximum number of tickets for this event.', {
      alreadyHeld: buyer.ticketsHeldForEvent,
      limit: maxTicketsPerIdentity,
    });
  }

  return ok({ price: listing.price });
}
