import type { FastifyInstance } from 'fastify';
import type { EpochMs } from '@rexell/domain';
import type { TokenService } from '../chain/token-service.js';
import type { ChainClient } from '../chain/client.js';

interface Deps {
  tokens?: TokenService | undefined;
  chain?: ChainClient | undefined;
  now: () => EpochMs;
}

/**
 * Operational surface for the chain.
 *
 * Deliberately small, and deliberately not on the critical path of anything. If
 * these routes returned 500 for a week, tickets would still sell and gates would
 * still open — which is the whole point of the outbox behind them.
 */
export function chainRoutes(app: FastifyInstance, { tokens, chain, now }: Deps): void {
  app.get('/v1/chain/status', async () => {
    if (!tokens) return { configured: false };

    const status = tokens.status();
    const health = chain ? await chain.health().catch(() => ({ up: false })) : { up: false };
    const at = now();

    return {
      configured: true,
      chainUp: health.up,
      ...status,
      /*
       * Work that was claimed and never resolved.
       *
       * A row submitted a moment ago is a drain in progress. One submitted an
       * hour ago is a transaction whose fate nobody established, and it will
       * never retry itself on purpose — retrying a mint that may have landed is
       * how one seat becomes two tokens. This is the number that needs a human.
       */
      strandedMs: status.oldestSubmittedAt === null ? 0 : at - status.oldestSubmittedAt,
      // How far behind the ledger is. This is the number to alert on — not
      // "chain down", which is routine, but "chain down and not catching up".
      oldestPendingAgeMs: status.oldestPendingAt === null ? 0 : at - status.oldestPendingAt,
    };
  });

  /**
   * Drain the outbox now.
   *
   * In production a scheduler calls this on a timer. Exposed as an endpoint so
   * an operator can force a catch-up after an incident, and so tests can advance
   * the chain deterministically instead of waiting on a background loop.
   */
  app.post('/v1/chain/drain', async (_req, reply) => {
    if (!tokens) return reply.code(503).send({ error: { code: 'CHAIN_NOT_CONFIGURED', message: 'No chain is configured.' } });
    const result = await tokens.drain();
    return reply.code(200).send(result);
  });
}
