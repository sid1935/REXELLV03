import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { EpochMs } from '@rexell/domain';
import { epochMs } from '@rexell/domain';
import { Db, Repo } from '@rexell/db';
import { HttpError, errorBody } from './errors.js';
import { registerIdempotency } from './idempotency.js';
import { commerceRoutes } from './routes/commerce.js';
import { identityRoutes } from './routes/identity.js';
import { gateRoutes } from './routes/gate.js';
import { chainRoutes } from './routes/chain.js';
import { scannerRoutes } from './routes/scanners.js';
import { RiskEngine, onsaleRoutes } from './routes/onsale.js';
import { organizerRoutes } from './routes/organizer.js';
import { FairQueue } from '@rexell/risk';
import { TokenService } from './chain/token-service.js';
import type { ChainClient } from './chain/client.js';
import type { VaultClient } from './vault-client.js';

export interface AppOptions {
  /** Where SQLite lives. `:memory:` for tests. */
  location?: string;
  /**
   * The clock, injected.
   *
   * Nothing in this service calls `Date.now()` directly. Resale windows,
   * cooldowns and hold expiry all have to be testable at an exact instant, and
   * a test that has to sleep for eight minutes to check a hold expiring is a
   * test nobody runs.
   */
  now?: () => EpochMs;
  logger?: boolean;
  /** The biometric vault. Without one, enrolment routes answer 503. */
  vault?: VaultClient;
  /**
   * Dev affordance: lets POST /v1/identities mark an identity enrolled without
   * going near the vault, so tests about commerce do not have to stand one up.
   *
   * Off by default and never set by `server.ts`. With it off, the only way to
   * become enrolled is a real challenge-plus-consent enrolment through the vault.
   */
  devMode?: boolean;
  /** The chain. Without one, tickets still sell — they simply never mint. */
  chain?: ChainClient;
  /**
   * Onsale admission control. Without one there is no waiting room, and every
   * request goes straight to origin — fine in development, not at an onsale.
   */
  onsale?: { drainPerSecond: number; tokenTtlMs?: number; secret?: Buffer; lottery?: boolean };
}

export interface App {
  server: FastifyInstance;
  db: Db;
  repo: Repo;
  tokens?: TokenService;
  risk: RiskEngine;
  queue?: FairQueue;
}

export function buildApp(options: AppOptions = {}): App {
  const db = new Db(options.location ?? ':memory:');
  const repo = new Repo(db);
  const now = options.now ?? (() => epochMs(Date.now()));

  const server = Fastify({ logger: options.logger ?? false });

  server.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send(errorBody(error.code, error.message, error.detail));
    }
    if ((error as { statusCode?: number }).statusCode === 400) {
      return reply.code(400).send(errorBody('BAD_REQUEST', (error as Error).message));
    }
    server.log.error(error);
    return reply.code(500).send(errorBody('INTERNAL', 'Something went wrong on our side.'));
  });

  server.setNotFoundHandler((req, reply) =>
    reply.code(404).send(errorBody('NOT_FOUND', `No route for ${req.method} ${req.url}.`)),
  );

  /**
   * CORS for the organizer console, which is served as static files from a
   * different origin. Wide open on purpose: every route behind it is
   * authenticated by an API key in a header, and a key in a header is not sent
   * automatically by a browser the way a cookie is — so there is no CSRF surface
   * for an origin allowlist to protect.
   */
  server.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-headers', 'content-type,authorization,x-api-key,idempotency-key');
    reply.header('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') await reply.code(204).send();
  });

  registerIdempotency(server, repo, now);

  server.get('/health', async () => ({ ok: true, at: now() }));

  const risk = new RiskEngine();
  const queue = options.onsale
    ? new FairQueue({
        drainPerSecond: options.onsale.drainPerSecond,
        tokenTtlMs: options.onsale.tokenTtlMs ?? 120_000,
        secret: options.onsale.secret ?? randomBytes(32),
        ...(options.onsale.lottery !== undefined ? { lottery: options.onsale.lottery } : {}),
      })
    : undefined;

  commerceRoutes(server, { repo, now, devMode: options.devMode ?? false, risk });
  identityRoutes(server, { repo, now, vault: options.vault });
  gateRoutes(server, { repo, now });
  scannerRoutes(server, { repo, now, vault: options.vault });

  const tokens = options.chain ? new TokenService(repo, options.chain, now) : undefined;
  chainRoutes(server, { tokens, chain: options.chain, now });
  onsaleRoutes(server, { repo, now, queue }, risk);
  organizerRoutes(server, { repo, now });

  return {
    server,
    db,
    repo,
    risk,
    ...(tokens ? { tokens } : {}),
    ...(queue ? { queue } : {}),
  };
}
