import type { FastifyInstance } from 'fastify';
import { HOUR, MINUTE, findDoubleEntries, epochMs, identityId as toIdentityId, laneId as toLaneId, ticketId as toTicketId } from '@rexell/domain';
import type { EntryAttestation, EpochMs } from '@rexell/domain';
import { verifyAttestation } from '@rexell/gate';
import type { SignedAttestation } from '@rexell/gate';
import type { Repo } from '@rexell/db';
import { HttpError, badRequest, errorBody, notFound } from '../errors.js';
import { VaultRejected, VaultUnavailable } from '../vault-client.js';
import type { VaultClient } from '../vault-client.js';

interface Deps {
  repo: Repo;
  now: () => EpochMs;
  vault?: VaultClient | undefined;
}

/** How long after the event ends a scanner's manifest stays openable. */
const MANIFEST_TTL_AFTER_END = 6 * HOUR;
/** How long before doors the key becomes releasable. */
const KEY_RELEASE_LEAD = 2 * HOUR;

export function scannerRoutes(app: FastifyInstance, { repo, now, vault }: Deps): void {
  const requireVault = (): VaultClient => {
    if (!vault) throw new HttpError(503, 'VAULT_NOT_CONFIGURED', 'No identity service is configured.');
    return vault;
  };

  /**
   * Provision a lane.
   *
   * The device generates its own keypair and registers the public half. The
   * private half never leaves it, which is what makes an attestation something
   * the device cannot later deny signing.
   */
  app.post<{
    Body: { scannerId: string; eventId: string; lane: string; gateGroup?: string; publicKeyPem: string };
  }>('/v1/scanners', async (req, reply) => {
    const b = req.body;
    if (!b?.scannerId || !b.eventId || !b.lane || !b.publicKeyPem) {
      throw badRequest('scannerId, eventId, lane and publicKeyPem are required.');
    }
    if (!repo.getEventRow(b.eventId)) throw notFound('event', b.eventId);
    if (!b.publicKeyPem.includes('BEGIN PUBLIC KEY')) throw badRequest('publicKeyPem must be an SPKI PEM public key.');

    repo.scanners.register({
      scannerId: b.scannerId,
      eventId: b.eventId,
      lane: b.lane,
      gateGroup: b.gateGroup ?? 'main',
      publicKeyPem: b.publicKeyPem,
      now: now(),
    });

    return reply.code(201).send({ scannerId: b.scannerId, eventId: b.eventId, lane: b.lane });
  });

  app.get<{ Params: { id: string } }>('/v1/events/:id/scanners', async (req) => {
    if (!repo.getEventRow(req.params.id)) throw notFound('event', req.params.id);
    return {
      scanners: repo.scanners.forEvent(req.params.id).map((s) => ({
        scannerId: s.scanner_id,
        lane: s.lane,
        gateGroup: s.gate_group,
        registeredAt: s.registered_at,
        lastSeenAt: s.last_seen_at,
      })),
    };
  });

  /**
   * Issue a sealed manifest for one scanner.
   *
   * Can be called days in advance and pushed over any channel — the blob is
   * inert without the key, which is a separate call with a time window.
   */
  app.post<{ Params: { id: string }; Body: { scannerId: string } }>(
    '/v1/events/:id/manifest/sealed',
    async (req, reply) => {
      const event = repo.getEventRow(req.params.id);
      if (!event) throw notFound('event', req.params.id);

      const scanner = repo.scanners.get(req.body?.scannerId ?? '');
      if (!scanner) throw notFound('scanner', req.body?.scannerId ?? '');

      const expiresAt = event.ends_at + MANIFEST_TTL_AFTER_END;
      const credentials = repo.scanners.credentialsForEvent(req.params.id, event.doors_open_at, event.ends_at);

      try {
        const result = await requireVault().sealManifest({
          scannerId: scanner.scanner_id,
          eventId: req.params.id,
          scope: 'global',
          sequence: event.manifest_sequence,
          expiresAt,
          releaseFrom: event.doors_open_at - KEY_RELEASE_LEAD,
          credentials,
        });

        return reply.code(201).send({
          ...result,
          keyReleasesAt: event.doors_open_at - KEY_RELEASE_LEAD,
          expiresAt,
        });
      } catch (e) {
        throw asHttpError(e);
      }
    },
  );

  /** Release the key. Refused outside the window; the vault decides, not us. */
  app.post<{ Params: { id: string }; Body: { scannerId: string } }>(
    '/v1/events/:id/manifest/key',
    async (req, reply) => {
      const event = repo.getEventRow(req.params.id);
      if (!event) throw notFound('event', req.params.id);
      const scanner = repo.scanners.get(req.body?.scannerId ?? '');
      if (!scanner) throw notFound('scanner', req.body?.scannerId ?? '');

      try {
        const result = await requireVault().releaseManifestKey({
          scannerId: scanner.scanner_id,
          eventId: req.params.id,
          expiresAt: event.ends_at + MANIFEST_TTL_AFTER_END,
        });
        repo.scanners.touch(scanner.scanner_id, now());
        return reply.code(200).send(result);
      } catch (e) {
        throw asHttpError(e);
      }
    },
  );

  /**
   * Upload a queue of signed decisions.
   *
   * Every attestation must verify against the key its scanner registered. An
   * unverifiable record is not stored: the value of this table after a disputed
   * night is that every row can be attributed, and one forged row destroys that
   * for all of them.
   *
   * Re-uploads are expected and free — a device that reconnects, drops and
   * reconnects sends the same batch twice, and the unique index makes the second
   * a no-op. The scanner can retry blindly rather than tracking acknowledgements.
   */
  app.post<{ Params: { id: string }; Body: { attestations: SignedAttestation[] } }>(
    '/v1/events/:id/attestations/signed',
    async (req, reply) => {
      const event = repo.getEventRow(req.params.id);
      if (!event) throw notFound('event', req.params.id);

      const batch = req.body?.attestations;
      if (!Array.isArray(batch)) throw badRequest('Body must contain an `attestations` array.');

      const verified: EntryAttestation[] = [];
      const rejected: Array<{ ticketId: string; reason: string }> = [];
      const keys = new Map<string, string>();

      for (const a of batch) {
        let publicKey = keys.get(a.scannerId);
        if (publicKey === undefined) {
          const scanner = repo.scanners.get(a.scannerId);
          if (!scanner) {
            rejected.push({ ticketId: a.ticketId, reason: 'UNKNOWN_SCANNER' });
            continue;
          }
          publicKey = scanner.public_key_pem;
          keys.set(a.scannerId, publicKey);
        }

        if (!verifyAttestation(a, publicKey)) {
          rejected.push({ ticketId: a.ticketId, reason: 'BAD_SIGNATURE' });
          continue;
        }

        verified.push({
          ticketId: toTicketId(a.ticketId),
          identityId: toIdentityId(a.identityId),
          lane: toLaneId(a.lane),
          decidedAt: epochMs(a.decidedAt),
          outcome: a.outcome,
          code: a.code,
          matchScore: a.matchScore,
          manifestSequence: a.manifestSequence,
          offline: a.offline,
        });
      }

      const inserted = repo.saveAttestations(req.params.id, verified, now());
      for (const id of keys.keys()) repo.scanners.touch(id, now());

      return reply.code(202).send({
        received: batch.length,
        verified: verified.length,
        inserted,
        duplicates: verified.length - inserted,
        rejected,
      });
    },
  );

  /**
   * Per-lane view of the night.
   *
   * The number an operations lead watches is `fallbackRate`: it is the one that
   * decides whether the queue moves, and a lane drifting above the others is
   * usually a camera pointing at the sun.
   */
  app.get<{ Params: { id: string } }>('/v1/events/:id/lanes', async (req) => {
    if (!repo.getEventRow(req.params.id)) throw notFound('event', req.params.id);

    const attestations = repo.attestationsForEvent(req.params.id);
    const byLane = new Map<string, { scans: number; admitted: number; denied: number; fallback: number; offline: number }>();

    for (const a of attestations) {
      const lane = byLane.get(a.lane) ?? { scans: 0, admitted: 0, denied: 0, fallback: 0, offline: 0 };
      lane.scans += 1;
      if (a.outcome === 'admit') lane.admitted += 1;
      else if (a.outcome === 'deny') lane.denied += 1;
      else lane.fallback += 1;
      if (a.offline) lane.offline += 1;
      byLane.set(a.lane, lane);
    }

    return {
      eventId: req.params.id,
      lanes: [...byLane.entries()]
        .map(([lane, s]) => ({
          lane,
          ...s,
          fallbackRate: s.scans === 0 ? 0 : Number((s.fallback / s.scans).toFixed(4)),
          offlineRate: s.scans === 0 ? 0 : Number((s.offline / s.scans).toFixed(4)),
        }))
        .sort((a, b) => (a.lane < b.lane ? -1 : 1)),
      doubleEntries: findDoubleEntries(attestations).length,
    };
  });
}

function asHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof VaultUnavailable) return new HttpError(503, 'VAULT_UNAVAILABLE', e.message);
  if (e instanceof VaultRejected) return new HttpError(e.status, e.code, e.message);
  return new HttpError(500, 'INTERNAL', 'Something went wrong on our side.');
}

export { MANIFEST_TTL_AFTER_END, KEY_RELEASE_LEAD, MINUTE, errorBody };
