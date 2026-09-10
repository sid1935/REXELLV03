import { randomBytes } from 'node:crypto';
import { buildApp } from './app.js';
import { FakeChain } from './chain/client.js';
import { httpVaultClient } from './vault-client.js';
import { ConfigError, describe, loadConfig } from './config.js';

/**
 * The API process.
 *
 * This composes the system. It used to build the app with none of its
 * collaborators wired, which meant `npm run dev` served an API where enrolment
 * answered 503, nothing ever minted and there was no waiting room — while the
 * tests exercised a fully assembled one. A dev environment that differs from the
 * tested one in what it *contains* is worse than no dev environment.
 *
 * Configuration is validated before anything opens a port: see `config.ts`. A
 * misconfigured production process exits non-zero with the list of problems
 * rather than starting in a weaker posture than the operator intended.
 */

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n[config] ${err.message}\n`);
    console.error('See docs/DEPLOYMENT.md for what each variable does.\n');
    process.exit(78); // EX_CONFIG
  }
  throw err;
}

/**
 * The chain.
 *
 * A simulator. There is exactly one implementation of `ChainClient` that runs —
 * `FakeChain` — and no adapter that speaks to an L2 has been written yet. The
 * Solidity in `packages/contracts` is real and tested, but nothing here deploys
 * or calls it. The simulator keeps the mint outbox, settlement reconciliation
 * and the `/v1/chain/*` surface alive, all of which are dead without one; it
 * does not make anything on this deployment on-chain, and it is reported as
 * `simulated` everywhere rather than as `ok`.
 */
const chain = new FakeChain();

const app = buildApp({
  location: config.dbPath,
  vault: httpVaultClient(config.vaultUrl, config.vaultToken),
  chain,
  onsale: {
    drainPerSecond: config.onsale.drainPerSecond,
    // Development only: a fresh secret per boot ejects everybody already
    // queued, which is why production requires one to be supplied.
    secret: config.onsale.secret.length > 0 ? config.onsale.secret : randomBytes(32),
    lottery: config.onsale.lottery,
  },
  rateLimit: config.rateLimit,
  signup: config.signup,
  trustProxy: config.trustProxy,
  // Never enabled here. The only way to become enrolled is a real challenge,
  // a consent record and a vault round trip.
  devMode: false,
  logger: true,
});

const { server } = app;

if (app.db.migration.applied.length > 0) {
  server.log.info(
    { from: app.db.migration.from, to: app.db.migration.to, applied: app.db.migration.applied },
    'schema migrated on startup',
  );
}

// Drain the chain outbox on a timer. Nothing waits for it; this is how the
// ledger catches up after an outage without anybody running a command.
const chainTimer = setInterval(() => {
  void app.tokens?.drain().then((r) => {
    if (r.mints.confirmed || r.resales.confirmed) {
      server.log.info({ mints: r.mints.confirmed, resales: r.resales.confirmed }, 'chain outbox drained');
    }
  });
}, config.chainDrainMs);

// Release the next batch of the waiting room on the same cadence.
const queueTimer = setInterval(() => {
  const released = app.queue?.drain(Date.now()) ?? [];
  app.queue?.sweep();
  if (released.length > 0) server.log.info({ released: released.length }, 'onsale batch admitted');
}, 1_000);

// Forget rate-limit buckets that have refilled. Without this the limiter is a
// slow leak keyed by client address, which is an unbounded set.
const limiterTimer = setInterval(() => app.limiter?.sweep(), 60_000);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // A second SIGTERM during a slow drain should not start a second shutdown.
    if (closing) return;
    closing = true;
    server.log.info({ signal }, 'shutting down');
    clearInterval(chainTimer);
    clearInterval(queueTimer);
    clearInterval(limiterTimer);
    void server.close().then(() => {
      app.db.close();
      process.exit(0);
    });
  });
}

// An unhandled rejection leaves the process alive in an unknown state, which is
// worse than gone: a supervisor restarts a dead process and cannot fix a sick one.
process.on('unhandledRejection', (reason) => {
  server.log.error({ reason }, 'unhandled rejection — exiting');
  process.exit(1);
});

server
  .listen({ port: config.port, host: config.host })
  .then(async () => {
    const health = await chain.health();
    server.log.info({ ...describe(config), chainUp: health.up }, 'ReXell API ready');
    if (config.signup.mode === 'open') {
      server.log.warn('signup is OPEN — anybody who can reach this port can mint an organizer API key');
    }
  })
  .catch((err: unknown) => {
    server.log.error(err);
    process.exit(1);
  });
