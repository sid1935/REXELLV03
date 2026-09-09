import type { FastifyInstance } from 'fastify';
import {
  HOUR,
  epochMs,
  findDoubleEntries,
  identityId as toIdentityId,
  laneId as toLaneId,
  ticketId as toTicketId,
} from '@rexell/domain';
import type { EntryAttestation, EpochMs } from '@rexell/domain';
import type { Repo } from '@rexell/db';
import { badRequest, notFound } from '../errors.js';

interface Deps {
  repo: Repo;
  now: () => EpochMs;
}

/** How long after doors a scanner's manifest stays usable before it self-erases. */
const MANIFEST_TTL_AFTER_END = 6 * HOUR;

export function gateRoutes(app: FastifyInstance, { repo, now }: Deps): void {
  /**
   * Key a scanner.
   *
   * In production the response is encrypted to the device and the templates are
   * sealed bytes from the vault. Here it carries pointers, which is enough to
   * build and test everything around it — and keeping templates out of this
   * response even in a prototype is the point, because prototype shapes become
   * production shapes.
   */
  app.get<{ Params: { id: string } }>('/v1/events/:id/manifest', async (req) => {
    const at = now();
    const eventRow = repo.getEventRow(req.params.id);
    if (!eventRow) throw notFound('event', req.params.id);

    const expiresAt = epochMs(eventRow.ends_at + MANIFEST_TTL_AFTER_END);
    const manifest = repo.buildManifest(req.params.id, expiresAt, at);
    if (!manifest) throw notFound('event', req.params.id);

    return {
      eventId: manifest.eventId,
      sequence: manifest.sequence,
      generatedAt: manifest.generatedAt,
      expiresAt: manifest.expiresAt,
      count: manifest.entries.size,
      entries: [...manifest.entries.values()],
    };
  });

  /**
   * Everything that changed since the scanner's sequence number.
   *
   * The scanner applies these with `applyDeltas`, which stops at the first gap
   * rather than guessing — so a truncated response here is safe, and that is why
   * a limit on the query is acceptable.
   */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/v1/events/:id/deltas',
    async (req) => {
      const eventRow = repo.getEventRow(req.params.id);
      if (!eventRow) throw notFound('event', req.params.id);

      const since = Number(req.query.since ?? 0);
      if (!Number.isInteger(since) || since < 0) throw badRequest('`since` must be a non-negative integer.');

      const deltas = repo.deltasSince(req.params.id, since);
      return {
        eventId: req.params.id,
        since,
        serverSequence: eventRow.manifest_sequence,
        deltas,
      };
    },
  );

  /**
   * A scanner uploading its queue.
   *
   * Re-uploads are expected: a device that reconnects, drops, and reconnects
   * sends the same batch twice. The unique index on (lane, decided_at, ticket_id)
   * makes the second upload a no-op, so the scanner can retry blindly rather than
   * having to track what it has acknowledged.
   */
  app.post<{ Params: { id: string }; Body: { attestations: unknown[] } }>(
    '/v1/events/:id/attestations',
    async (req, reply) => {
      const eventRow = repo.getEventRow(req.params.id);
      if (!eventRow) throw notFound('event', req.params.id);

      const raw = req.body?.attestations;
      if (!Array.isArray(raw)) throw badRequest('Body must contain an `attestations` array.');

      const batch: EntryAttestation[] = raw.map((a) => {
        const r = a as Record<string, unknown>;
        return {
          ticketId: toTicketId(String(r['ticketId'] ?? 'unknown')),
          identityId: toIdentityId(String(r['identityId'] ?? 'unknown')),
          lane: toLaneId(String(r['lane'] ?? 'unknown')),
          decidedAt: epochMs(Number(r['decidedAt'])),
          outcome: r['outcome'] as EntryAttestation['outcome'],
          code: r['code'] as EntryAttestation['code'],
          matchScore: Number(r['matchScore'] ?? 0),
          manifestSequence: Number(r['manifestSequence'] ?? 0),
          offline: Boolean(r['offline']),
        };
      });

      const inserted = repo.saveAttestations(req.params.id, batch, now());
      return reply.code(202).send({ received: batch.length, inserted, duplicates: batch.length - inserted });
    },
  );

  /**
   * Reconciliation.
   *
   * Expected to be empty. When it is not, at least one lane was offline, and the
   * `offline` and `manifestSequence` fields on each attestation say which one and
   * how stale it was — which is the entire justification for recording them.
   */
  app.get<{ Params: { id: string } }>('/v1/events/:id/reconciliation', async (req) => {
    const eventRow = repo.getEventRow(req.params.id);
    if (!eventRow) throw notFound('event', req.params.id);

    const attestations = repo.attestationsForEvent(req.params.id);
    const doubles = findDoubleEntries(attestations);

    const admitted = attestations.filter((a) => a.outcome === 'admit').length;
    const denied = attestations.filter((a) => a.outcome === 'deny').length;
    const fallback = attestations.filter((a) => a.outcome === 'fallback').length;
    const total = attestations.length;

    return {
      eventId: req.params.id,
      scans: total,
      admitted,
      denied,
      fallback,
      // The number the whole product is judged on. See the roadmap KPI table.
      fallbackRate: total === 0 ? 0 : Number((fallback / total).toFixed(4)),
      doubleEntries: doubles.map((d) => ({
        ticketId: d.ticketId,
        lanes: d.attestations.map((a) => ({
          lane: a.lane,
          decidedAt: a.decidedAt,
          offline: a.offline,
          manifestSequence: a.manifestSequence,
        })),
      })),
    };
  });
}
