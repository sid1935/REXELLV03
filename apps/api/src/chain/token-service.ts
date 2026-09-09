import type { Repo } from '@rexell/db';
import type { EpochMs } from '@rexell/domain';
import type { ChainClient, MintRequest } from './client.js';

/**
 * Token Service.
 *
 * The only writer to the chain, so every on-chain mutation has exactly one
 * audited code path. It drains the outbox in batches and is expected to fail
 * regularly — a sequencer outage is a Tuesday, not an incident.
 *
 * The contract with the rest of the system:
 *
 *   - Nothing waits for it. A ticket is issued, sellable and scannable the
 *     moment the database row exists.
 *   - It is idempotent. The outbox's unique index means a ticket is enqueued
 *     once, and a confirmed row is never reprocessed.
 *   - It never invents state. If the chain says nothing, the ticket stays
 *     `pending` and the database remains the source of truth — which it is for
 *     entry purposes anyway, permanently.
 */
export interface DrainResult {
  readonly attempted: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly errors: readonly string[];
}

export class TokenService {
  constructor(
    private readonly repo: Repo,
    private readonly chain: ChainClient,
    private readonly now: () => EpochMs,
    private readonly batchSize = 50,
  ) {}

  /**
   * Drain pending mints.
   *
   * Batched into a single chain call: at onsale volume, one transaction per
   * ticket is a bad trade against one transaction per fifty. A batch that fails
   * fails as a unit and every op in it is retried next pass, which is safe
   * precisely because minting is keyed on ticket id.
   */
  async drainMints(): Promise<DrainResult> {
    const pending = this.repo.outbox.claimPending('mint', this.batchSize);
    if (pending.length === 0) return { attempted: 0, confirmed: 0, failed: 0, errors: [] };

    const requests: MintRequest[] = pending.map((row) => JSON.parse(row.payload) as MintRequest);

    try {
      const receipts = await this.chain.mintBatch(requests);
      const at = this.now();
      const byTicket = new Map(receipts.map((r) => [r.ticketId, r]));

      let confirmed = 0;
      for (const row of pending) {
        const req = JSON.parse(row.payload) as MintRequest;
        const receipt = byTicket.get(req.ticketId);
        if (!receipt) {
          // The chain accepted the batch but said nothing about this ticket.
          // Treat it as unconfirmed rather than assuming success.
          this.repo.outbox.markFailed(row.op_id, 'no receipt returned for ticket');
          continue;
        }
        this.repo.outbox.markConfirmed(row.op_id, receipt.txHash, at);
        this.repo.outbox.setTicketMintState(req.ticketId, 'confirmed', receipt.tokenId);
        confirmed += 1;
      }

      return { attempted: pending.length, confirmed, failed: pending.length - confirmed, errors: [] };
    } catch (e) {
      const message = (e as Error).message;
      for (const row of pending) this.repo.outbox.markFailed(row.op_id, message);
      // Not thrown. A failed drain is an expected outcome that the caller logs
      // and retries; throwing here would take down whatever scheduled it.
      return { attempted: pending.length, confirmed: 0, failed: pending.length, errors: [message] };
    }
  }

  async drainResales(): Promise<DrainResult> {
    const pending = this.repo.outbox.claimPending('resale', this.batchSize);
    let confirmed = 0;
    const errors: string[] = [];

    for (const row of pending) {
      const payload = JSON.parse(row.payload) as {
        settlementId: string;
        eventId: string;
        ticketId: string;
        toIdentityId: string;
        priceMinor: number;
      };
      try {
        const { txHash } = await this.chain.recordResale(payload);
        this.repo.outbox.markConfirmed(row.op_id, txHash, this.now());
        confirmed += 1;
      } catch (e) {
        const message = (e as Error).message;
        this.repo.outbox.markFailed(row.op_id, message);
        errors.push(message);
      }
    }

    return { attempted: pending.length, confirmed, failed: pending.length - confirmed, errors };
  }

  async drain(): Promise<{ mints: DrainResult; resales: DrainResult }> {
    return { mints: await this.drainMints(), resales: await this.drainResales() };
  }

  status() {
    return this.repo.outbox.status();
  }
}
