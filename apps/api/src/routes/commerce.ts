import type { FastifyInstance } from 'fastify';
import {
  MINUTE,
  computeSplits,
  epochMs,
  evaluateListing,
  evaluateListingPurchase,
  evaluatePurchase,
  identityId as toIdentityId,
  applyTicketEvent,
  minor,
  validateEvent,
} from '@rexell/domain';
import type { EpochMs, EventDef, PurchaserContext, RiskVerdict } from '@rexell/domain';
import type { Repo } from '@rexell/db';
import { HttpError, badRequest, errorBody, notFound, statusFor } from '../errors.js';
import type { RiskEngine } from './onsale.js';

/** How long inventory is held while a fan finishes checkout. */
export const HOLD_TTL_MS = 8 * MINUTE;

interface Deps {
  repo: Repo;
  now: () => EpochMs;
  devMode: boolean;
  risk: RiskEngine;
}

/** Tier index on chain. Tiers are stored in creation order in TicketNFT. */
function tierIndexOf(repo: Repo, eventId: string, tierId: string): number {
  const event = repo.getEvent(eventId);
  return event ? event.tiers.findIndex((t) => t.id === tierId) : 0;
}

function purchaserContext(repo: Repo, identity: string, eventId: string, risk: RiskEngine): PurchaserContext {
  const row = repo.getIdentity(toIdentityId(identity));
  if (!row) throw notFound('identity', identity);
  const base = {
    identityId: toIdentityId(identity),
    enrolled: row.enrolled === 1,
    blocked: row.blocked === 1,
    ticketsHeldForEvent: repo.ticketsHeldForEvent(toIdentityId(identity), eventId),
    // The verdict computed when this session joined the onsale queue. A session
    // that never went through the queue has none, and gets the benefit of the
    // doubt — refusing on absence would block every non-onsale purchase.
    riskVerdict: (risk.verdictFor(identity) ?? 'allow') as RiskVerdict,
  };
  return row.age_years === null ? base : { ...base, ageYears: row.age_years };
}

function requireTier(repo: Repo, tierId: string) {
  const found = repo.getTier(tierId);
  if (!found) throw notFound('tier', tierId);
  return found;
}

export function commerceRoutes(app: FastifyInstance, { repo, now, devMode, risk }: Deps): void {
  // ─ identities ─

  app.post<{ Body: { enrolled?: boolean; ageYears?: number } }>('/v1/identities', async (req, reply) => {
    // Outside dev mode a new identity is NOT enrolled, whatever the body says.
    // Enrolment is a challenge, a consent record and a vault round trip — it is
    // not a boolean a client can assert about itself.
    const enrolled = devMode ? req.body?.enrolled !== false : false;
    const id = repo.createIdentity(
      {
        enrolled,
        ...(req.body?.ageYears !== undefined ? { ageYears: req.body.ageYears } : {}),
      },
      now(),
    );
    return reply.code(201).send({ identityId: id, enrolled });
  });

  // ─ events ─

  app.post<{ Body: { event: EventDef; organizerName?: string } }>('/v1/events', async (req, reply) => {
    const body = req.body?.event;
    if (!body) throw badRequest('Body must contain an `event`.');

    // Rehydrate through the branded constructors so a hand-written JSON payload
    // cannot smuggle a float face value or a negative allocation past the types.
    const event: EventDef = {
      ...body,
      salesOpenAt: epochMs(body.salesOpenAt),
      salesCloseAt: epochMs(body.salesCloseAt),
      doorsOpenAt: epochMs(body.doorsOpenAt),
      endsAt: epochMs(body.endsAt),
      tiers: body.tiers.map((t) => ({
        ...t,
        faceValue: minor(t.faceValue),
        resale: {
          ...t.resale,
          opensAt: epochMs(t.resale.opensAt),
          closesAt: epochMs(t.resale.closesAt),
        },
      })),
    };

    try {
      validateEvent(event);
    } catch (e) {
      throw new HttpError(400, 'INVALID_POLICY', (e as Error).message);
    }

    repo.createOrganizer(req.body.organizerName ?? 'Organizer', now(), event.organizerId);
    repo.createEvent(event, now());
    return reply.code(201).send({ eventId: event.id, policyHash: repo.getEventRow(event.id)?.policy_hash });
  });

  // ─ buying ─

  app.post<{ Body: { identityId: string; tierId: string; quantity: number } }>(
    '/v1/orders',
    async (req, reply) => {
      const { identityId, tierId, quantity } = req.body ?? {};
      if (!identityId || !tierId) throw badRequest('identityId and tierId are required.');

      const at = now();
      repo.releaseExpiredHolds(at);

      const { tier, availability } = requireTier(repo, tierId);
      const event = repo.getEvent(tier.eventId);
      if (!event) throw notFound('event', tier.eventId);

      const buyer = purchaserContext(repo, identityId, event.id, risk);
      const verdict = evaluatePurchase(event, { tier, quantity: quantity ?? 1, now: at }, buyer, availability);
      if (!verdict.ok) {
        return reply.code(statusFor(verdict.code)).send(errorBody(verdict.code, verdict.message, verdict.detail));
      }

      const expiresAt = epochMs(at + HOLD_TTL_MS);
      const holdId = repo.reserve(tierId, quantity, buyer.identityId, expiresAt, at);
      if (holdId === null) {
        // Lost the race between the availability read and the reservation. The
        // conditional UPDATE is what makes this a clean 409 rather than an
        // oversell discovered at the gate.
        return reply
          .code(statusFor('SOLD_OUT'))
          .send(errorBody('SOLD_OUT', 'Those tickets went while you were checking out.'));
      }

      const amount = minor(tier.faceValue * quantity);
      const orderId = repo.createOrder({
        identityId: buyer.identityId,
        eventId: event.id,
        tierId,
        holdId,
        quantity,
        amount,
        riskVerdict: buyer.riskVerdict,
        now: at,
      });

      return reply.code(201).send({ orderId, holdId, quantity, amountMinor: amount, holdExpiresAt: expiresAt });
    },
  );

  app.post<{ Params: { id: string }; Body: { authRef?: string } }>('/v1/orders/:id/pay', async (req, reply) => {
    const at = now();
    const order = repo.getOrder(req.params.id);
    if (!order) throw notFound('order', req.params.id);
    if (order.state !== 'pending') {
      return reply.code(409).send(errorBody('ORDER_NOT_PENDING', `This order is already ${order.state}.`));
    }

    const result = repo.db.tx(() => {
      if (!order.hold_id || !repo.convertHold(order.hold_id, at)) {
        return { failed: 'HOLD_EXPIRED' as const };
      }
      repo.markOrderPaid(order.order_id, req.body?.authRef ?? `auth_${order.order_id}`, at);

      const tickets: string[] = [];
      for (let i = 0; i < order.quantity; i += 1) {
        const ticketId = repo.issueTicket({
          eventId: order.event_id,
          tierId: order.tier_id,
          owner: toIdentityId(order.identity_id),
          orderId: order.order_id,
          now: at,
        });
        tickets.push(ticketId);
        // Enqueue the mint. Nothing waits for it: the ticket is already valid,
        // sellable and scannable. If the chain is down for an hour, this row
        // simply waits, and the sale is unaffected.
        repo.outbox.enqueue({
          kind: 'mint',
          eventId: order.event_id,
          refId: ticketId,
          payload: {
            ticketId,
            eventId: order.event_id,
            identityId: order.identity_id,
            tierIndex: tierIndexOf(repo, order.event_id, order.tier_id),
          },
          now: at,
        });
        // The gate learns about the ticket now, not at doors-open. A late sale
        // is just another delta.
        repo.appendDelta(
          order.event_id,
          'add',
          { kind: 'add', entry: { ticketId, identityId: order.identity_id, tierId: order.tier_id } },
          at,
        );
      }
      return { tickets };
    });

    if ('failed' in result) {
      return reply
        .code(409)
        .send(errorBody('HOLD_EXPIRED', 'Your reservation ran out. Please start again — the tickets went back on sale.'));
    }

    return reply.code(201).send({ orderId: order.order_id, state: 'paid', tickets: result.tickets });
  });

  app.get<{ Params: { id: string } }>('/v1/identities/:id/tickets', async (req) => {
    const tickets = repo.ticketsByOwner(toIdentityId(req.params.id));
    return {
      tickets: tickets.map((t) => ({
        id: t.id,
        eventId: t.eventId,
        tierId: t.tierId,
        state: t.state,
        acquiredAt: t.acquiredAt,
        resaleCount: t.resaleCount,
      })),
    };
  });

  // ─ resale ─

  app.post<{ Body: { ticketId: string; identityId: string; priceMinor: number } }>(
    '/v1/listings',
    async (req, reply) => {
      const { ticketId, identityId, priceMinor } = req.body ?? {};
      if (!ticketId || !identityId) throw badRequest('ticketId and identityId are required.');

      const at = now();
      const ticket = repo.getTicket(ticketId);
      if (!ticket) throw notFound('ticket', ticketId);
      const { tier } = requireTier(repo, ticket.tierId);

      const seller = {
        identityId: toIdentityId(identityId),
        activeListings: repo.activeListingsFor(toIdentityId(identityId)),
      };

      const verdict = evaluateListing(ticket, tier, minor(priceMinor), seller, at);
      if (!verdict.ok) {
        return reply.code(statusFor(verdict.code)).send(errorBody(verdict.code, verdict.message, verdict.detail));
      }

      const listingId = repo.db.tx(() => {
        const moved = applyTicketEvent(ticket, { kind: 'list' });
        if (!moved.ok) throw new HttpError(409, moved.code, moved.message);
        repo.saveTicket(moved.value);
        return repo.createListing({ ticketId, seller: seller.identityId, price: minor(priceMinor), now: at });
      });

      return reply.code(201).send({
        listingId,
        ticketId,
        priceMinor,
        ceilingMinor: verdict.value.ceiling,
        floorMinor: verdict.value.floor,
      });
    },
  );

  app.get<{ Params: { id: string } }>('/v1/events/:id/listings', async (req) => {
    const listings = repo.listingsForEvent(req.params.id);
    return {
      listings: listings.map((l) => ({
        id: l.id,
        ticketId: l.ticketId,
        priceMinor: l.price,
        listedAt: l.listedAt,
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: { buyerIdentityId: string; expectedPriceMinor: number } }>(
    '/v1/listings/:id/buy',
    async (req, reply) => {
      const at = now();
      const listing = repo.getListing(req.params.id);
      if (!listing) throw notFound('listing', req.params.id);

      const ticket = repo.getTicket(listing.ticketId);
      if (!ticket) throw notFound('ticket', listing.ticketId);
      const { tier } = requireTier(repo, ticket.tierId);
      const event = repo.getEvent(tier.eventId);
      if (!event) throw notFound('event', tier.eventId);

      /*
       * Validated here rather than defaulted to ''.
       *
       * This used to read `req.body?.buyerIdentityId ?? ''`, hand the empty
       * string to `identityId()`, and get back a raw "must not be empty" throw
       * — which the error handler turns into a 500. So a client with a typo in
       * a field name was told the server had broken, on the one route where
       * money changes hands. The sibling route two hundred lines up validates
       * properly; this one was simply missed.
       */
      if (!req.body?.buyerIdentityId) throw badRequest('`buyerIdentityId` is required.');
      if (!Number.isInteger(req.body?.expectedPriceMinor)) {
        throw badRequest('`expectedPriceMinor` is required, as an integer number of minor units.');
      }

      const buyer = purchaserContext(repo, req.body.buyerIdentityId, event.id, risk);
      const verdict = evaluateListingPurchase(
        listing,
        tier,
        buyer,
        minor(req.body.expectedPriceMinor),
        event.maxTicketsPerIdentity,
        at,
      );
      if (!verdict.ok) {
        return reply.code(statusFor(verdict.code)).send(errorBody(verdict.code, verdict.message, verdict.detail));
      }

      const outcome = repo.db.tx(() => {
        // Claim first. Everything after this point assumes exactly one buyer won.
        if (!repo.claimListing(listing.id, buyer.identityId, at)) {
          return { failed: true as const };
        }

        const split = computeSplits(listing.price, tier.resale.splits);
        const settlementId = repo.recordSettlement({
          listingId: listing.id,
          ticketId: ticket.id,
          split,
          now: at,
        });

        const sold = applyTicketEvent(ticket, { kind: 'sell', toIdentity: buyer.identityId, at });
        if (!sold.ok) throw new HttpError(409, sold.code, sold.message);
        repo.saveTicket(sold.value);

        // The edge that makes the biometric binding mean anything: the seller's
        // face stops opening the gate the moment the sale settles.
        const seq = repo.appendDelta(
          event.id,
          'rebind',
          {
            kind: 'rebind',
            ticketId: ticket.id,
            identityId: buyer.identityId,
            templateRef: `tpl:${buyer.identityId}`,
          },
          at,
        );

        repo.outbox.enqueue({
          kind: 'resale',
          eventId: event.id,
          refId: settlementId,
          payload: {
            settlementId,
            eventId: event.id,
            ticketId: ticket.id,
            // Both sides of the trade. The chain does not transfer a ticket, it
            // runs a sale: the controller opens a listing for the seller and
            // closes it for the buyer, and that is what applies the price cap
            // and records the royalty split on chain rather than only here.
            fromIdentityId: ticket.ownerIdentityId,
            toIdentityId: buyer.identityId,
            priceMinor: listing.price,
          },
          now: at,
        });

        return { settlementId, split, seq };
      });

      if ('failed' in outcome) {
        return reply.code(statusFor('LISTING_NOT_ACTIVE')).send(
          errorBody('LISTING_NOT_ACTIVE', 'This ticket has already gone.'),
        );
      }

      return reply.code(201).send({
        settlementId: outcome.settlementId,
        ticketId: ticket.id,
        newOwner: buyer.identityId,
        pricePaidMinor: listing.price,
        split: {
          organizerMinor: outcome.split.organizer,
          platformMinor: outcome.split.platform,
          rightsHolderMinor: outcome.split.rightsHolder,
          sellerMinor: outcome.split.seller,
        },
        manifestSequence: outcome.seq,
      });
    },
  );

  app.get<{ Params: { id: string } }>('/v1/events/:id/settlement', async (req) => {
    const rows = repo.settlementsForEvent(req.params.id);
    const totals = rows.reduce(
      (acc, r) => ({
        resaleVolumeMinor: acc.resaleVolumeMinor + r.sale_price_minor,
        organizerMinor: acc.organizerMinor + r.organizer_minor,
        platformMinor: acc.platformMinor + r.platform_minor,
        rightsHolderMinor: acc.rightsHolderMinor + r.rights_holder_minor,
        sellerMinor: acc.sellerMinor + r.seller_minor,
      }),
      { resaleVolumeMinor: 0, organizerMinor: 0, platformMinor: 0, rightsHolderMinor: 0, sellerMinor: 0 },
    );
    return { resales: rows.length, ...totals };
  });
}
