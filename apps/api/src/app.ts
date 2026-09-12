import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { EpochMs } from '@rexell/domain';
import { epochMs } from '@rexell/domain';
import { Db, Repo, schemaStatus } from '@rexell/db';
import { HttpError, errorBody } from './errors.js';
import { secretEquals } from './auth.js';
import { registerIdempotency } from './idempotency.js';
import { registerRateLimit } from './rate-limit.js';
import type { RateLimitOptions } from './rate-limit.js';
import { commerceRoutes } from './routes/commerce.js';
import { identityRoutes } from './routes/identity.js';
import { gateRoutes } from './routes/gate.js';
import { chainRoutes } from './routes/chain.js';
import { scannerRoutes } from './routes/scanners.js';
import { RiskEngine, onsaleRoutes } from './routes/onsale.js';
import { organizerRoutes } from './routes/organizer.js';
import { discoverRoutes } from './routes/discover.js';
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
  /**
   * Request throttling. Absent means unthrottled, which is right for tests and
   * wrong for anything reachable from outside — `server.ts` always sets it.
   */
  rateLimit?: RateLimitOptions;
  /**
   * Who may call the unauthenticated writes, `POST /v1/organizers` and
   * `POST /v1/events`.
   *
   * `open` is the demo and test posture: anybody can sign themselves up and get
   * a working key, which is the whole point of M6. `invite` requires a shared
   * token in `x-signup-token`. There is no third mode — a deployment either
   * lets strangers create organizers or it does not.
   */
  signup?: { mode: 'open' } | { mode: 'invite'; token: string };
  /**
   * Whether to believe `x-forwarded-for`. True only when something you control
   * terminates TLS in front of this process and overwrites that header.
   */
  trustProxy?: boolean;
}

export interface App {
  server: FastifyInstance;
  db: Db;
  repo: Repo;
  tokens?: TokenService;
  risk: RiskEngine;
  queue?: FairQueue;
  /** Present only when throttling is configured; `server.ts` sweeps it on a timer. */
  limiter?: { sweep: () => void };
}

export function buildApp(options: AppOptions = {}): App {
  const db = new Db(options.location ?? ':memory:');
  const repo = new Repo(db);
  const now = options.now ?? (() => epochMs(Date.now()));

  const server = Fastify({
    logger: options.logger ?? false,
    // Off unless a proxy really is in front. With it on and the port directly
    // reachable, a caller chooses its own rate-limit bucket with one header.
    trustProxy: options.trustProxy ?? false,
    // A body larger than this is not a purchase, and parsing it is free work
    // done on somebody else's behalf.
    bodyLimit: 256 * 1024,
  });

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

  /**
   * The response headers that cost nothing and close whole categories.
   *
   * No HSTS here: this process speaks plain HTTP and the proxy in front of it
   * is what knows whether TLS is real. Setting it from here would either be a
   * lie in development or a duplicate in production.
   */
  server.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    // This is a JSON API. Nothing it returns should ever be framed, and no
    // browser should be executing anything it sends.
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });

  // Before idempotency and before the routes: work refused for rate is work
  // that should not reach a database transaction.
  const limiter = options.rateLimit ? registerRateLimit(server, options.rateLimit, now) : undefined;

  if (options.signup?.mode === 'invite') {
    const expected = options.signup.token;
    server.addHook('onRequest', async (req) => {
      if (req.method !== 'POST') return;
      const path = (req.url.split('?')[0] ?? '').replace(/\/+$/, '');
      if (path !== '/v1/organizers' && path !== '/v1/events') return;

      const presented = req.headers['x-signup-token'];
      if (typeof presented !== 'string' || !secretEquals(presented, expected)) {
        throw new HttpError(
          403,
          'SIGNUP_CLOSED',
          'Organizer signup on this deployment is by invitation. Present a valid `x-signup-token`.',
        );
      }
    });
  }

  registerIdempotency(server, repo, now);

  server.get('/health', async (_req, reply) => {
    const schema = schemaStatus(db.handle);
    // A process serving traffic against a schema it does not match is the state
    // this reports. It answers unhealthy so a load balancer takes it out rather
    // than a human noticing later.
    return reply.code(schema.upToDate ? 200 : 503).send({ ok: schema.upToDate, at: now(), schema });
  });

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
  // Anything claimed by the process that died here never left, or it would have
  // a transaction hash. Put it back before the first drain.
  if (tokens) repo.outbox.releaseUnsent();
  chainRoutes(server, { tokens, chain: options.chain, now });
  onsaleRoutes(server, { repo, now, queue }, risk);
  organizerRoutes(server, { repo, now });
  // Last, so the public event view wins over nothing and is easy to find.
  discoverRoutes(server, { repo, now });

  return {
    server,
    db,
    repo,
    risk,
    ...(tokens ? { tokens } : {}),
    ...(queue ? { queue } : {}),
    ...(limiter ? { limiter } : {}),
  };
}
