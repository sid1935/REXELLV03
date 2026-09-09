import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { EpochMs } from '@rexell/domain';
import { epochMs } from '@rexell/domain';
import { Db, Repo } from '@rexell/db';
import { HttpError, errorBody } from './errors.js';
import { registerIdempotency } from './idempotency.js';
import { commerceRoutes } from './routes/commerce.js';
import { gateRoutes } from './routes/gate.js';

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
}

export interface App {
  server: FastifyInstance;
  db: Db;
  repo: Repo;
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

  registerIdempotency(server, repo, now);

  server.get('/health', async () => ({ ok: true, at: now() }));

  commerceRoutes(server, { repo, now });
  gateRoutes(server, { repo, now });

  return { server, db, repo };
}
