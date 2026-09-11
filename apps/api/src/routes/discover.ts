import type { FastifyInstance } from 'fastify';
import { AVAILABILITY_LABEL, availabilityOf, isDiscoverable, resaleCeiling } from '@rexell/domain';
import type { EpochMs } from '@rexell/domain';
import type { Repo } from '@rexell/db';
import { badRequest, notFound } from '../errors.js';

interface Deps {
  repo: Repo;
  now: () => EpochMs;
}

const MAX_PAGE = 100;

/**
 * The public surface.
 *
 * Everything here is unauthenticated and cacheable, which makes it the part of
 * the system most likely to be scraped and the part where a careless field is
 * hardest to take back. The rule for anything added below:
 *
 *   a fan needs it, or it does not go in.
 *
 * Specifically NOT here, and each for a reason somebody would be angry about:
 *
 *   sold / held      an organizer's sales curve, reconstructible by polling.
 *                    Published as a coarse band instead.
 *   commission split their private terms with ReXell and with the artist.
 *   manifestSequence an internal counter that leaks ticketing volume.
 *   organizer id     an identifier for a tenant, useful only for enumeration.
 */
export function discoverRoutes(app: FastifyInstance, { repo, now }: Deps): void {
  /**
   * What is on sale.
   *
   * Sold-out events stay listed: a fan wants to know the show exists and that
   * resale may open. Closed ones do not — an event nobody can buy into is noise
   * that generates support tickets.
   */
  app.get<{ Querystring: { limit?: string; offset?: string; q?: string } }>('/v1/discover', async (req, reply) => {
    const at = now();
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit ?? 20)));
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    if (!Number.isFinite(limit) || !Number.isFinite(offset)) throw badRequest('limit and offset must be numbers.');

    // A hold that lapsed a moment ago must not make an event look sold out.
    repo.releaseExpiredHolds(at);

    // Searched in the database rather than by the caller, so a term still
    // finds an event that sits past the first page.
    const q = (req.query.q ?? '').slice(0, 80);
    const rows = repo.catalogue.onSale(at, limit, offset, q);
    const total = repo.catalogue.countOnSale(at);

    return reply.header('cache-control', 'public, max-age=15').send({
      total,
      limit,
      offset,
      ...(q.trim() ? { q: q.trim() } : {}),
      events: rows.map((r) => {
        const availability = availabilityOf({ allocation: r.allocation, sold: r.sold, held: r.held });
        return {
          id: r.event_id,
          name: r.name,
          venue: r.venue,
          organizer: r.organizer_name,
          doorsOpenAt: r.doors_open_at,
          endsAt: r.ends_at,
          salesCloseAt: r.sales_close_at,
          fromMinor: r.min_face_value,
          resaleAllowed: r.any_capped === 1,
          availability,
          availabilityLabel: AVAILABILITY_LABEL[availability],
        };
      }),
    });
  });

  /**
   * One event, as a fan sees it.
   *
   * Replaces the old unauthenticated view, which returned exact sold and held
   * counts, the internal manifest sequence, and the organizer's commission
   * split. The organizer's own precise numbers live behind a key at
   * `/v1/events/:id/analytics`.
   *
   * `policyHash` stays public on purpose: anchoring the terms is worthless if
   * nobody outside can check them against what was promised.
   */
  app.get<{ Params: { id: string } }>('/v1/events/:id', async (req, reply) => {
    const at = now();
    repo.releaseExpiredHolds(at);

    const event = repo.getEvent(req.params.id);
    const row = repo.getEventRow(req.params.id);
    if (!event || !row) throw notFound('event', req.params.id);

    const organizer = repo.organizers.get(row.organizer_id);

    const tiers = event.tiers.map((tier) => {
      const found = repo.getTier(tier.id);
      const counts = {
        allocation: tier.allocation,
        sold: found?.availability.sold ?? 0,
        held: found?.availability.held ?? 0,
      };
      const availability = availabilityOf(counts);
      return {
        id: tier.id,
        name: tier.name,
        faceValueMinor: tier.faceValue,
        availability,
        availabilityLabel: AVAILABILITY_LABEL[availability],
        resale:
          tier.resale.mode === 'capped'
            ? {
                allowed: true,
                // A fan needs the ceiling — it is the promise being made to
                // them. They do not need who the difference is split between.
                ceilingMinor: resaleCeiling(tier),
                opensAt: tier.resale.opensAt,
                closesAt: tier.resale.closesAt,
              }
            : { allowed: false },
      };
    });

    const overall = availabilityOf(
      event.tiers.reduce(
        (acc, tier) => {
          const found = repo.getTier(tier.id);
          return {
            allocation: acc.allocation + tier.allocation,
            sold: acc.sold + (found?.availability.sold ?? 0),
            held: acc.held + (found?.availability.held ?? 0),
          };
        },
        { allocation: 0, sold: 0, held: 0 },
      ),
    );

    return reply.header('cache-control', 'public, max-age=10').send({
      id: event.id,
      name: event.name,
      venue: row.venue ?? null,
      organizer: organizer?.name ?? null,
      capacity: event.capacity,
      salesOpenAt: event.salesOpenAt,
      salesCloseAt: event.salesCloseAt,
      doorsOpenAt: event.doorsOpenAt,
      endsAt: event.endsAt,
      maxTicketsPerIdentity: event.maxTicketsPerIdentity,
      allowReentry: event.allowReentry,
      onSale: isDiscoverable(event, at),
      availability: overall,
      availabilityLabel: AVAILABILITY_LABEL[overall],
      // Verifiable by anyone, which is the entire point of anchoring it.
      policyHash: row.policy_hash,
      tiers,
    });
  });
}
