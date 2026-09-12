import type { Repo } from '@rexell/db';
import type { EpochMs } from '@rexell/domain';
import { ChainUncertain } from './client.js';
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
  /*
   * The drain runs on a five-second timer and the call is not awaited, so a
   * drain that takes longer than the interval used to overlap with the next
   * one. The atomic claim in `claimPending` is what makes that safe; this only
   * stops the pointless second pass.
   */
  #draining = false;

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
    const pending = this.repo.outbox.claimPending('mint', this.batchSize, this.now());
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
        // Uncertainty is not failure. A batch whose transaction was sent and
      // never confirmed must not be retried — that is how one seat becomes two
      // tokens — so those rows stay claimed and wait for a person.
      for (const row of pending) {
        if (e instanceof ChainUncertain) this.repo.outbox.markUncertain(row.op_id, e.txHash, message);
        else this.repo.outbox.markFailed(row.op_id, message);
      }
      // Not thrown. A failed drain is an expected outcome that the caller logs
      // and retries; throwing here would take down whatever scheduled it.
      return { attempted: pending.length, confirmed: 0, failed: pending.length, errors: [message] };
    }
  }

  async drainResales(): Promise<DrainResult> {
    const pending = this.repo.outbox.claimPending('resale', this.batchSize, this.now());
    let confirmed = 0;
    const errors: string[] = [];

    for (const row of pending) {
      const payload = JSON.parse(row.payload) as {
        settlementId: string;
        eventId: string;
        ticketId: string;
        fromIdentityId: string;
        toIdentityId: string;
        priceMinor: number;
      };
      try {
        /*
         * The token id, from the only place it exists.
         *
         * A resale cannot be recorded before the mint it transfers has landed —
         * there is no token to move yet. That is the correct order of events and
         * not a failure: the row stays pending and the next drain tries again,
         * by which time the mint outbox has almost certainly caught up.
         *
         * Leaving it out entirely is what the first version of this did, and
         * the chain client was left guessing from the ticket id. It guessed that
         * a ticket id might be a number. They never are.
         */
        const tokenId = this.repo.outbox.tokenIdFor(payload.ticketId);
        if (!tokenId) {
          throw new Error(`ticket ${payload.ticketId} has no confirmed mint yet`);
        }

        const { txHash } = await this.chain.recordResale({ ...payload, tokenId });
        this.repo.outbox.markConfirmed(row.op_id, txHash, this.now());
        confirmed += 1;
      } catch (e) {
        const message = (e as Error).message;
        if (e instanceof ChainUncertain) this.repo.outbox.markUncertain(row.op_id, e.txHash, message);
        else this.repo.outbox.markFailed(row.op_id, message);
        errors.push(message);
      }
    }

    return { attempted: pending.length, confirmed, failed: pending.length - confirmed, errors };
  }

  /**
   * Drain revocations.
   *
   * Unlike a mint, this one is not merely eventual. A revoked ticket stops
   * opening gates the moment the database row changes — the gate reads the
   * manifest, not the chain — so nobody is admitted while this is pending. What
   * waits is agreement: until this lands, the token still reads as valid to
   * anybody querying the contract, which is exactly the claim an on-chain ticket
   * is supposed to make unfalsifiable.
   *
   * One transaction each rather than a batch. Revocations arrive in ones and
   * twos as chargebacks land, not in the thousands that make batching a mint
   * worth the complexity.
   */
  async drainRevocations(): Promise<DrainResult> {
    const pending = this.repo.outbox.claimPending('revoke', this.batchSize, this.now());
    let confirmed = 0;
    const errors: string[] = [];

    for (const row of pending) {
      const payload = JSON.parse(row.payload) as { ticketId: string; eventId: string; reason: string };
      try {
        // Absent while the mint is still in flight. The row stays pending and
        // the next pass tries again, by which time the mint has almost certainly
        // confirmed — the same ordering the resale drain relies on.
        const tokenId = this.repo.outbox.tokenIdFor(payload.ticketId);
        if (!tokenId) throw new Error(`ticket ${payload.ticketId} has no confirmed mint yet`);

        const { txHash } = await this.chain.revoke({ ...payload, tokenId });
        this.repo.outbox.markConfirmed(row.op_id, txHash, this.now());
        confirmed += 1;
      } catch (e) {
        const message = (e as Error).message;
        if (e instanceof ChainUncertain) this.repo.outbox.markUncertain(row.op_id, e.txHash, message);
        else this.repo.outbox.markFailed(row.op_id, message);
        errors.push(message);
      }
    }

    return { attempted: pending.length, confirmed, failed: pending.length - confirmed, errors };
  }

  async drain(): Promise<{ mints: DrainResult; resales: DrainResult; revocations: DrainResult }> {
    const idle = { attempted: 0, confirmed: 0, failed: 0, errors: [] };
    if (this.#draining) return { mints: idle, resales: idle, revocations: idle };
    this.#draining = true;
    try {
      return {
        mints: await this.drainMints(),
        resales: await this.drainResales(),
        revocations: await this.drainRevocations(),
      };
    } finally {
      this.#draining = false;
    }
  }

  status() {
    return this.repo.outbox.status();
  }
}
