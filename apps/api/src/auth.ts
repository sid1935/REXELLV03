import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { EpochMs } from '@rexell/domain';
import type { Repo, Scope } from '@rexell/db';
import { HttpError } from './errors.js';

/**
 * API key authentication for organizers.
 *
 * Keys are shown once, at creation, and stored only as a SHA-256 hash. There is
 * no route that returns a key, and no support tool that can recover one — the
 * remedy for a lost key is a new key, which is also the remedy for a leaked one.
 *
 * SHA-256 rather than a password hash: these are 256 bits of CSPRNG output, not
 * something a person chose, so there is nothing to brute-force and no reason to
 * pay bcrypt's cost on every request at onsale rates.
 */

const PREFIX = 'rxl_live_';

export interface Principal {
  readonly organizerId: string;
  readonly keyId: string;
  readonly scopes: readonly Scope[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const secret = randomBytes(32).toString('base64url');
  const key = `${PREFIX}${secret}`;
  return {
    key,
    hash: hashKey(key),
    // Enough to tell four keys apart in a list, not enough to help anybody.
    prefix: `${PREFIX}${secret.slice(0, 6)}…`,
  };
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function extractKey(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const direct = req.headers['x-api-key'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  return undefined;
}

/**
 * Resolve the caller.
 *
 * Throws rather than returning null: every route that calls this requires a
 * principal, and an accidental `if (!principal)` that falls through to serving
 * the request is exactly the bug this shape prevents.
 */
export function authenticate(repo: Repo, req: FastifyRequest, now: () => EpochMs): Principal {
  const key = extractKey(req);
  if (!key) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Provide an API key as `Authorization: Bearer rxl_live_…`.');
  }

  const row = repo.organizers.findByHash(hashKey(key));
  if (!row) {
    // The same error whether the key is malformed, unknown or revoked. Telling
    // a caller which one is telling them whether a guessed key exists.
    throw new HttpError(401, 'UNAUTHENTICATED', 'That API key is not valid.');
  }
  if (row.revoked_at !== null) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'That API key is not valid.');
  }

  const organizer = repo.organizers.get(row.organizer_id);
  if (!organizer || organizer.state !== 'active') {
    throw new HttpError(403, 'ORGANIZER_SUSPENDED', 'This account is suspended. Please contact support.');
  }

  repo.organizers.touchKey(row.key_id, now());
  return {
    organizerId: row.organizer_id,
    keyId: row.key_id,
    scopes: row.scopes.split(',').filter(Boolean) as Scope[],
  };
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.includes(scope)) {
    throw new HttpError(403, 'INSUFFICIENT_SCOPE', `This key does not have the '${scope}' scope.`);
  }
}

/**
 * Tenancy.
 *
 * The single most important check in this file. An organizer reading another
 * organizer's sales figures is a breach, and it is the kind that happens by
 * forgetting a WHERE clause rather than by anybody attacking anything.
 *
 * A 404, not a 403: confirming that an event exists but belongs to somebody
 * else leaks that it exists.
 */
export function requireOwnership(repo: Repo, principal: Principal, eventId: string): void {
  if (!repo.organizers.ownsEvent(principal.organizerId, eventId)) {
    throw new HttpError(404, 'NOT_FOUND', `No event with id ${eventId}.`);
  }
}

/** Constant-time compare, for anywhere a secret is checked outside the hash path. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
