import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
  ChallengeStore,
  PROTOTYPE_MODEL,
  issueChallenge,
  pickKind,
  toFaceVector,
  verifyChallenge,
} from '@rexell/biometrics';
import { VaultStore } from './store.js';

/**
 * The biometric vault.
 *
 * The whole point of this service is what it does NOT expose. There is no route
 * that returns a template, encrypted or otherwise, to anybody, ever. Callers
 * submit a probe and receive a boolean and a score. If you find yourself adding
 * `GET /templates/:ref`, stop — that route is the difference between a breach
 * that leaks pseudonyms and a breach that leaks faces.
 *
 * `test/no-read-path.test.ts` asserts this by enumerating the router.
 *
 * In production this runs in its own account, its own VPC, behind mTLS, with the
 * master key in an HSM under split custody. Here it is a separate process with a
 * separate database and separate keys, which preserves the shape of the boundary
 * even though it does not yet have the operational teeth.
 */
export interface VaultOptions {
  location?: string;
  masterKey?: Buffer;
  receiptKey?: Buffer;
  /** Root of the manifest key derivation. Defaults to the master key. */
  manifestKey?: Buffer;
  now?: () => number;
  logger?: boolean;
  /** Shared secret the API presents. Stands in for mTLS. */
  serviceToken?: string;
}

export interface VaultApp {
  server: FastifyInstance;
  store: VaultStore;
  challenges: ChallengeStore;
}

const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

export function buildVault(options: VaultOptions = {}): VaultApp {
  const now = options.now ?? (() => Date.now());
  const store = new VaultStore({
    ...(options.location !== undefined ? { location: options.location } : {}),
    masterKey: options.masterKey ?? randomBytes(32),
    receiptKey: options.receiptKey ?? randomBytes(32),
    ...(options.manifestKey !== undefined ? { manifestKey: options.manifestKey } : {}),
  });
  const challenges = new ChallengeStore();
  const serviceToken = options.serviceToken;

  const server = Fastify({ logger: options.logger ?? false, bodyLimit: 256 * 1024 });

  // Stands in for mTLS. Every route is authenticated; there is no public surface.
  server.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    if (serviceToken === undefined) return;
    if (req.headers['x-vault-token'] !== serviceToken) {
      await bad(reply, 401, 'UNAUTHORISED', 'This service is not reachable without a client certificate.');
    }
  });

  server.get('/health', async () => ({ ok: true, model: PROTOTYPE_MODEL }));

  /**
   * Step one of enrolment. The server chooses the action and the nonce, so a
   * template captured earlier cannot be replayed into a later enrolment.
   */
  server.post('/v1/challenges', async (_req, reply) => {
    const at = now();
    challenges.sweep(at);
    const challenge = issueChallenge(
      {
        id: `chl_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        nonce: randomBytes(24).toString('base64url'),
        kind: pickKind(randomBytes(1)[0] ?? 0),
      },
      at,
    );
    challenges.put(challenge);
    return reply.code(201).send(challenge);
  });

  interface EnrolBody {
    identityId: string;
    scope: string;
    consentId: string;
    vector: number[];
    modelVersion?: string;
    liveness: { challengeId: string; nonce: string; passiveScore: number; actionCompleted: boolean };
  }

  server.post<{ Body: EnrolBody }>('/v1/enrol', async (req, reply) => {
    const at = now();
    const b = req.body;
    if (!b?.identityId || !b.scope || !b.consentId) {
      return bad(reply, 400, 'BAD_REQUEST', 'identityId, scope and consentId are required.');
    }
    if (!Array.isArray(b.vector)) return bad(reply, 400, 'BAD_REQUEST', 'vector is required.');

    // Consumed whether or not verification succeeds, so a failed attempt burns
    // the nonce and cannot be retried against a different template.
    const challenge = challenges.consume(b.liveness?.challengeId ?? '');
    const live = verifyChallenge(challenge, b.liveness, at);
    if (!live.ok) {
      return bad(reply, 403, 'LIVENESS_FAILED', `Liveness check failed: ${live.reason}.`);
    }

    const modelVersion = b.modelVersion ?? PROTOTYPE_MODEL;
    if (modelVersion !== PROTOTYPE_MODEL) {
      return bad(reply, 409, 'MODEL_VERSION_MISMATCH', `This vault matches ${PROTOTYPE_MODEL}.`);
    }

    let vector;
    try {
      vector = toFaceVector(b.vector);
    } catch (e) {
      return bad(reply, 400, 'BAD_REQUEST', (e as Error).message);
    }

    const result = store.enrol({
      identityId: b.identityId,
      scope: b.scope,
      vector,
      modelVersion,
      consentId: b.consentId,
      now: at,
    });

    // Note what comes back: a reference, a status, and scores. Not a template.
    return reply.code(201).send(result);
  });

  server.post<{ Body: { identityId: string; scope: string; probe: number[] } }>(
    '/v1/verify',
    async (req, reply) => {
      const b = req.body;
      if (!b?.identityId || !b.scope || !Array.isArray(b.probe)) {
        return bad(reply, 400, 'BAD_REQUEST', 'identityId, scope and probe are required.');
      }
      try {
        return store.verify({ identityId: b.identityId, scope: b.scope, probe: toFaceVector(b.probe), now: now() });
      } catch (e) {
        return bad(reply, 400, 'BAD_REQUEST', (e as Error).message);
      }
    },
  );

  server.post<{ Body: { scope: string; probe: number[] } }>('/v1/identify', async (req, reply) => {
    const b = req.body;
    if (!b?.scope || !Array.isArray(b.probe)) return bad(reply, 400, 'BAD_REQUEST', 'scope and probe are required.');
    try {
      return store.identify({ scope: b.scope, probe: toFaceVector(b.probe), now: now() });
    } catch (e) {
      return bad(reply, 400, 'BAD_REQUEST', (e as Error).message);
    }
  });

  server.post<{ Body: { identityId: string; reason?: string } }>('/v1/forget', async (req, reply) => {
    const b = req.body;
    if (!b?.identityId) return bad(reply, 400, 'BAD_REQUEST', 'identityId is required.');
    const receipt = store.forget(b.identityId, b.reason ?? 'consent_withdrawn', now());
    return reply.code(200).send(receipt);
  });

  server.get<{ Params: { scope: string } }>('/v1/scopes/:scope/flags', async (req) => ({
    scope: req.params.scope,
    flags: store.openFlags(req.params.scope),
  }));

  server.post<{ Params: { id: string }; Body: { resolution: 'same_person' | 'different_people' } }>(
    '/v1/flags/:id/resolve',
    async (req, reply) => {
      const okDone = store.resolveFlag(req.params.id, req.body?.resolution ?? 'different_people', now());
      if (!okDone) return bad(reply, 409, 'FLAG_NOT_OPEN', 'That flag is already resolved.');
      return reply.code(200).send({ flagId: req.params.id, resolved: true });
    },
  );

  /**
   * Seal an event manifest for one scanner.
   *
   * The one path by which template material leaves the vault. What comes back is
   * ciphertext bound to this device, this event and this expiry — distributable
   * over any channel, openable by nobody until the key is released.
   */
  server.post<{
    Body: {
      scannerId: string;
      eventId: string;
      scope?: string;
      sequence?: number;
      expiresAt: number;
      releaseFrom: number;
      credentials: Array<{
        ticketId: string;
        identityId: string;
        tierId: string;
        seat?: string;
        gates?: string[];
        admitFrom: number;
        admitUntil: number;
        revoked?: boolean;
      }>;
    };
  }>('/v1/manifests', async (req, reply) => {
    const b = req.body;
    if (!b?.scannerId || !b.eventId || !Array.isArray(b.credentials)) {
      return bad(reply, 400, 'BAD_REQUEST', 'scannerId, eventId and credentials are required.');
    }

    const result = store.sealGateManifest({
      scannerId: b.scannerId,
      eventId: b.eventId,
      scope: b.scope ?? 'global',
      sequence: b.sequence ?? 0,
      expiresAt: b.expiresAt,
      releaseFrom: b.releaseFrom,
      now: now(),
      credentials: b.credentials.map((c) => ({
        ticketId: c.ticketId,
        identityId: c.identityId,
        tierId: c.tierId,
        ...(c.seat !== undefined ? { seat: c.seat } : {}),
        gates: c.gates ?? [],
        admitFrom: c.admitFrom,
        admitUntil: c.admitUntil,
        revoked: c.revoked ?? false,
      })),
    });

    return reply.code(201).send({
      sealed: result.sealed,
      included: result.included,
      // Named, so an operator knows who to expect at the resolution desk rather
      // than discovering it one refused fan at a time.
      missingTemplates: result.missing,
    });
  });

  /**
   * Release a manifest key.
   *
   * Refused before the release window and after expiry. This is what makes early
   * distribution safe: a blob sitting on a device for three days is inert until
   * the night it is for.
   */
  server.post<{ Body: { scannerId: string; eventId: string; expiresAt: number } }>(
    '/v1/manifest-keys',
    async (req, reply) => {
      const b = req.body;
      if (!b?.scannerId || !b.eventId || typeof b.expiresAt !== 'number') {
        return bad(reply, 400, 'BAD_REQUEST', 'scannerId, eventId and expiresAt are required.');
      }
      const result = store.releaseManifestKey(b.scannerId, b.eventId, b.expiresAt, now());
      if ('refused' in result) {
        const status = result.refused === 'UNKNOWN_MANIFEST' ? 404 : 409;
        return bad(reply, status, result.refused, 'This manifest key cannot be released right now.');
      }
      return reply.code(200).send(result);
    },
  );

  server.get('/v1/manifests', async () => ({ manifests: store.manifestLog() }));

  return { server, store, challenges };
}
