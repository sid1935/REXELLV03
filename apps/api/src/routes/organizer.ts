import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  computeSplits,
  findDoubleEntries,
  minor,
  organizerId as toOrganizerId,
  resaleCeiling,
  validateEvent,
} from '@rexell/domain';
import type { EpochMs, EventDef } from '@rexell/domain';
import { ALL_SCOPES } from '@rexell/db';
import type { Repo, Scope } from '@rexell/db';
import { HttpError, badRequest, notFound } from '../errors.js';
import { authenticate, generateApiKey, requireOwnership, requireScope } from '../auth.js';

interface Deps {
  repo: Repo;
  now: () => EpochMs;
}

const id = (prefix: string) => `${prefix}_${randomBytes(10).toString('hex')}`;

export function organizerRoutes(app: FastifyInstance, { repo, now }: Deps): void {
  const principalOf = (req: FastifyRequest) => authenticate(repo, req, now);

  // ─── onboarding ──────────────────────────────────────────────────────────

  /**
   * Self-serve signup.
   *
   * The only unauthenticated write in the organizer surface, and the whole point
   * of M6: an organizer reaches a working API key without anybody at ReXell
   * touching anything. Every event, scanner and payout below flows from this.
   *
   * In production this sits behind email verification and a rate limit; neither
   * changes the shape of what follows.
   */
  app.post<{ Body: { name: string; contactEmail?: string } }>('/v1/organizers', async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) throw badRequest('`name` is required.');

    const at = now();
    const organizerId = id('org');
    const key = generateApiKey();

    repo.db.tx(() => {
      repo.organizers.create({
        id: organizerId,
        name,
        ...(req.body?.contactEmail ? { contactEmail: req.body.contactEmail } : {}),
        now: at,
      });
      repo.organizers.addKey({
        keyId: id('key'),
        organizerId,
        name: 'Initial key',
        keyHash: key.hash,
        prefix: key.prefix,
        scopes: ALL_SCOPES,
        now: at,
      });
    });

    return reply.code(201).send({
      organizerId,
      name,
      // Shown exactly once. There is no route that returns it again, and no
      // support tool that can recover it — the remedy for losing it is a new
      // key, which is also the remedy for leaking it.
      apiKey: key.key,
      scopes: ALL_SCOPES,
      warning: 'Store this key now. It cannot be retrieved again.',
    });
  });

  app.get('/v1/me', async (req) => {
    const principal = principalOf(req);
    const organizer = repo.organizers.get(principal.organizerId);
    return {
      organizerId: principal.organizerId,
      name: organizer?.name,
      scopes: principal.scopes,
      events: repo.organizers.eventsFor(principal.organizerId).length,
    };
  });

  app.get('/v1/keys', async (req) => {
    const principal = principalOf(req);
    return {
      keys: repo.organizers.keysFor(principal.organizerId).map((k) => ({
        keyId: k.key_id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes.split(','),
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at,
        revokedAt: k.revoked_at,
      })),
    };
  });

  app.post<{ Body: { name?: string; scopes?: Scope[] } }>('/v1/keys', async (req, reply) => {
    const principal = principalOf(req);
    const requested = req.body?.scopes ?? principal.scopes;

    // A key cannot mint a key with more power than itself, or a compromised
    // read-only key becomes a write key in one call.
    for (const scope of requested) {
      if (!principal.scopes.includes(scope)) {
        throw new HttpError(403, 'INSUFFICIENT_SCOPE', `Cannot grant '${scope}': this key does not hold it.`);
      }
    }

    const key = generateApiKey();
    repo.organizers.addKey({
      keyId: id('key'),
      organizerId: principal.organizerId,
      name: req.body?.name ?? 'Key',
      keyHash: key.hash,
      prefix: key.prefix,
      scopes: requested,
      now: now(),
    });

    return reply.code(201).send({ apiKey: key.key, scopes: requested, warning: 'Store this key now.' });
  });

  app.delete<{ Params: { id: string } }>('/v1/keys/:id', async (req, reply) => {
    const principal = principalOf(req);
    const revoked = repo.organizers.revokeKey(principal.organizerId, req.params.id, now());
    if (!revoked) throw notFound('active key', req.params.id);
    return reply.code(200).send({ revoked: true });
  });

  // ─── events ──────────────────────────────────────────────────────────────

  app.get('/v1/events', async (req) => {
    const principal = principalOf(req);
    requireScope(principal, 'events:read');
    return {
      events: repo.organizers.eventsFor(principal.organizerId).map((e) => ({
        id: e.event_id,
        name: e.name,
        capacity: e.capacity,
        doorsOpenAt: e.doors_open_at,
      })),
    };
  });

  /**
   * Create an event under the calling organizer.
   *
   * Distinct from the unauthenticated `POST /v1/events` used by the seed and by
   * tests: this one takes the organizer from the key rather than the body, so a
   * caller cannot create an event owned by somebody else.
   */
  app.post<{ Body: { event: Omit<EventDef, 'organizerId'> } }>('/v1/organizer/events', async (req, reply) => {
    const principal = principalOf(req);
    requireScope(principal, 'events:write');

    const body = req.body?.event;
    if (!body) throw badRequest('Body must contain an `event`.');

    // The organizer comes from the key, never the body, so a caller cannot
    // create an event owned by somebody else.
    const event: EventDef = {
      ...body,
      organizerId: toOrganizerId(principal.organizerId),
      tiers: body.tiers.map((t) => ({ ...t, faceValue: minor(t.faceValue) })),
    };

    try {
      validateEvent(event);
    } catch (e) {
      throw new HttpError(400, 'INVALID_POLICY', (e as Error).message);
    }
    if (repo.getEventRow(event.id)) throw new HttpError(409, 'EVENT_EXISTS', `Event ${event.id} already exists.`);

    repo.createEvent(event, now());
    return reply.code(201).send({
      eventId: event.id,
      policyHash: repo.getEventRow(event.id)?.policy_hash,
      tiers: event.tiers.map((t) => ({
        id: t.id,
        mode: t.resale.mode,
        ceilingMinor: t.resale.mode === 'capped' ? resaleCeiling(t) : null,
      })),
    });
  });

  // ─── analytics ───────────────────────────────────────────────────────────

  /**
   * Everything an organizer watches during a sale and on the night.
   *
   * One call rather than five, because a dashboard polling five endpoints at
   * onsale is five times the load for no benefit.
   */
  app.get<{ Params: { id: string } }>('/v1/events/:id/analytics', async (req) => {
    const principal = principalOf(req);
    requireScope(principal, 'analytics:read');
    requireOwnership(repo, principal, req.params.id);

    const event = repo.getEvent(req.params.id);
    if (!event) throw notFound('event', req.params.id);
    repo.releaseExpiredHolds(now());

    const tiers = event.tiers.map((t) => {
      const found = repo.getTier(t.id);
      const sold = found?.availability.sold ?? 0;
      return {
        id: t.id,
        name: t.name,
        faceValueMinor: t.faceValue,
        allocation: t.allocation,
        sold,
        held: found?.availability.held ?? 0,
        remaining: t.allocation - sold - (found?.availability.held ?? 0),
        grossMinor: sold * t.faceValue,
        sellThrough: t.allocation === 0 ? 0 : Number((sold / t.allocation).toFixed(4)),
      };
    });

    const grossMinor = tiers.reduce((n, t) => n + t.grossMinor, 0);
    const sold = tiers.reduce((n, t) => n + t.sold, 0);

    const listings = repo.listingsForEvent(req.params.id);
    const settlements = repo.settlementsForEvent(req.params.id);
    const resaleVolume = settlements.reduce((n, s) => n + s.sale_price_minor, 0);
    const organizerCommission = settlements.reduce((n, s) => n + s.organizer_minor, 0);

    const attestations = repo.attestationsForEvent(req.params.id);
    const admitted = attestations.filter((a) => a.outcome === 'admit').length;
    const fallback = attestations.filter((a) => a.outcome === 'fallback').length;

    return {
      eventId: req.params.id,
      name: event.name,
      sales: {
        sold,
        capacity: event.capacity,
        grossMinor,
        sellThrough: event.capacity === 0 ? 0 : Number((sold / event.capacity).toFixed(4)),
        tiers,
      },
      resale: {
        activeListings: listings.length,
        completed: settlements.length,
        volumeMinor: resaleVolume,
        // The number that sells the platform: revenue on transactions that
        // today produce the organizer nothing at all.
        organizerCommissionMinor: organizerCommission,
        attachRate: sold === 0 ? 0 : Number((settlements.length / sold).toFixed(4)),
      },
      attendance: {
        scans: attestations.length,
        admitted,
        denied: attestations.filter((a) => a.outcome === 'deny').length,
        fallback,
        // The operational number. Above ~1.5% the resolution desk becomes the queue.
        fallbackRate: attestations.length === 0 ? 0 : Number((fallback / attestations.length).toFixed(4)),
        turnout: sold === 0 ? 0 : Number((admitted / sold).toFixed(4)),
        doubleEntries: findDoubleEntries(attestations).length,
      },
    };
  });

  // ─── settlement ──────────────────────────────────────────────────────────

  /**
   * Settlement, reconciled three ways.
   *
   * An organizer being asked to trust a number is the situation this product
   * exists to remove, so the report states each resale's split, recomputes it
   * from the tier policy, and says whether the chain has confirmed it.
   *
   *   recomputed  — the stored split matches what the policy says it should be.
   *                 Catches a bug or an edit in the settlement row itself.
   *   balanced    — the parts sum to the sale price, to the paisa.
   *   onChain     — a confirmed transaction exists for it.
   *
   * A row failing the first two is a defect and is listed as one. A row failing
   * only the third is normal: the chain lags and is allowed to.
   */
  app.get<{ Params: { id: string } }>('/v1/events/:id/settlement/report', async (req) => {
    const principal = principalOf(req);
    requireScope(principal, 'settlement:read');
    requireOwnership(repo, principal, req.params.id);

    const event = repo.getEvent(req.params.id);
    if (!event) throw notFound('event', req.params.id);

    const rows = repo.db.all<{
      settlement_id: string;
      listing_id: string;
      ticket_id: string;
      sale_price_minor: number;
      organizer_minor: number;
      platform_minor: number;
      rights_holder_minor: number;
      seller_minor: number;
      created_at: number;
    }>(
      `SELECT s.* FROM settlements s JOIN tickets t ON t.ticket_id = s.ticket_id WHERE t.event_id = ? ORDER BY s.created_at`,
      req.params.id,
    );

    const chainState = new Map(
      repo.db
        .all<{ ref_id: string; state: string; tx_hash: string | null }>(
          `SELECT ref_id, state, tx_hash FROM chain_outbox WHERE kind = 'resale' AND event_id = ?`,
          req.params.id,
        )
        .map((r) => [r.ref_id, r]),
    );

    const discrepancies: Array<{ settlementId: string; problem: string; detail: unknown }> = [];
    let onChain = 0;
    let pending = 0;

    const lines = rows.map((r) => {
      const ticket = repo.getTicket(r.ticket_id);
      const tier = ticket ? repo.getTier(ticket.tierId) : undefined;

      let recomputed = true;
      if (tier) {
        const expected = computeSplits(minor(r.sale_price_minor), tier.tier.resale.splits);
        recomputed =
          expected.organizer === r.organizer_minor &&
          expected.platform === r.platform_minor &&
          expected.rightsHolder === r.rights_holder_minor &&
          expected.seller === r.seller_minor;
        if (!recomputed) {
          discrepancies.push({
            settlementId: r.settlement_id,
            problem: 'STORED_SPLIT_DIFFERS_FROM_POLICY',
            detail: { stored: r, expected },
          });
        }
      }

      const balanced =
        r.organizer_minor + r.platform_minor + r.rights_holder_minor + r.seller_minor === r.sale_price_minor;
      if (!balanced) {
        discrepancies.push({ settlementId: r.settlement_id, problem: 'SPLIT_DOES_NOT_BALANCE', detail: r });
      }

      const chain = chainState.get(r.settlement_id);
      const confirmed = chain?.state === 'confirmed';
      if (confirmed) onChain += 1;
      else pending += 1;

      return {
        settlementId: r.settlement_id,
        ticketId: r.ticket_id,
        salePriceMinor: r.sale_price_minor,
        organizerMinor: r.organizer_minor,
        platformMinor: r.platform_minor,
        rightsHolderMinor: r.rights_holder_minor,
        sellerMinor: r.seller_minor,
        recomputed,
        balanced,
        onChain: confirmed,
        txHash: chain?.tx_hash ?? null,
        at: r.created_at,
      };
    });

    const totals = lines.reduce(
      (acc, l) => ({
        volumeMinor: acc.volumeMinor + l.salePriceMinor,
        organizerMinor: acc.organizerMinor + l.organizerMinor,
        platformMinor: acc.platformMinor + l.platformMinor,
        rightsHolderMinor: acc.rightsHolderMinor + l.rightsHolderMinor,
        sellerMinor: acc.sellerMinor + l.sellerMinor,
      }),
      { volumeMinor: 0, organizerMinor: 0, platformMinor: 0, rightsHolderMinor: 0, sellerMinor: 0 },
    );

    return {
      eventId: req.params.id,
      resales: lines.length,
      totals,
      chain: {
        confirmed: onChain,
        // Not a fault. The chain is deliberately behind and the payout does not
        // wait for it.
        awaiting: pending,
      },
      reconciled: discrepancies.length === 0,
      discrepancies,
      lines,
    };
  });
}
