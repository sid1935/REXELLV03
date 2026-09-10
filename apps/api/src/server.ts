import { randomBytes } from 'node:crypto';
import { buildApp } from './app.js';
import { FakeChain } from './chain/client.js';
import { httpVaultClient } from './vault-client.js';

/**
 * The API process.
 *
 * This composes the system. It used to build the app with none of its
 * collaborators wired, which meant `npm run dev` served an API where enrolment
 * answered 503, nothing ever minted and there was no waiting room — while the
 * tests exercised a fully assembled one. A dev environment that differs from the
 * tested one in what it *contains* is worse than no dev environment.
 */

const port = Number(process.env['PORT'] ?? 8080);
const vaultUrl = process.env['VAULT_URL'] ?? 'http://127.0.0.1:8090';
const vaultToken = process.env['VAULT_TOKEN'];

/**
 * The chain.
 *
 * `FakeChain` unless a real endpoint is configured. It is honest about being a
 * simulator and it keeps the mint outbox, settlement reconciliation and the
 * `/v1/chain/*` surface alive in development, all of which are dead without one.
 */
const chain = new FakeChain();

const app = buildApp({
  location: process.env['REXELL_DB'] ?? 'rexell.sqlite',
  vault: httpVaultClient(vaultUrl, vaultToken),
  chain,
  onsale: {
    // What the origin can actually serve. Deliberately low in development so the
    // waiting room is visible rather than theoretical.
    drainPerSecond: Number(process.env['ONSALE_DRAIN_PER_SECOND'] ?? 200),
    secret: process.env['ONSALE_SECRET']
      ? Buffer.from(process.env['ONSALE_SECRET'], 'base64')
      : randomBytes(32),
    lottery: process.env['ONSALE_LOTTERY'] !== 'false',
  },
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
const drainMs = Number(process.env['CHAIN_DRAIN_MS'] ?? 5_000);
const chainTimer = setInterval(() => {
  void app.tokens?.drain().then((r) => {
    if (r.mints.confirmed || r.resales.confirmed) {
      server.log.info({ mints: r.mints.confirmed, resales: r.resales.confirmed }, 'chain outbox drained');
    }
  });
}, drainMs);

// Release the next batch of the waiting room on the same cadence.
const queueTimer = setInterval(() => {
  const released = app.queue?.drain(Date.now()) ?? [];
  app.queue?.sweep();
  if (released.length > 0) server.log.info({ released: released.length }, 'onsale batch admitted');
}, 1_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(chainTimer);
    clearInterval(queueTimer);
    void server.close().then(() => {
      app.db.close();
      process.exit(0);
    });
  });
}

server
  .listen({ port, host: '0.0.0.0' })
  .then(async () => {
    const health = await chain.health();
    server.log.info(
      { vault: vaultUrl, chain: health.up ? 'simulated' : 'down', onsale: true },
      'ReXell API ready',
    );
  })
  .catch((err: unknown) => {
    server.log.error(err);
    process.exit(1);
  });
