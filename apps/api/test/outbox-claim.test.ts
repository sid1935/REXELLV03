import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, epochMs } from '@rexell/domain';
import type { EpochMs } from '@rexell/domain';
import { buildApp } from '../src/app.js';
import type { App } from '../src/app.js';
import { ChainUnavailable, ChainUncertain, FakeChain, PartialBatch } from '../src/chain/client.js';
import type { MintReceipt, MintRequest } from '../src/chain/client.js';

/**
 * One seat, one token.
 *
 * `claimPending` used to be a bare SELECT that marked nothing. The drain runs on
 * a five-second timer and the call is not awaited, so any drain slower than the
 * interval — a batch of fifty mints, or the congested chain that makes draining
 * slow in the first place — started a second drain over rows the first was still
 * working on. `mintTo` has no idempotency key, so both minted: two tokens in
 * circulation for one seat.
 *
 * The unique index on (kind, ref_id) does not help. It stops a second row being
 * enqueued for the same ticket; it has nothing to say about one row being read
 * twice.
 */

const T0 = 1_780_000_000_000;
const DOORS = T0 + 30 * DAY;

let app: App;
let clock = T0;
const now = (): EpochMs => epochMs(clock);

const post = (url: string, body: unknown = {}) =>
  app.server.inject({ method: 'POST', url, payload: body as object });

const EVENT = {
  id: 'evt_claim',
  organizerId: 'org_claim',
  name: 'Claim Test',
  capacity: 100,
  salesOpenAt: T0,
  salesCloseAt: DOORS - 2 * HOUR,
  doorsOpenAt: DOORS,
  endsAt: DOORS + 10 * HOUR,
  maxTicketsPerIdentity: 4,
  allowReentry: false,
  tiers: [
    {
      id: 'tier_ga',
      eventId: 'evt_claim',
      name: 'GA',
      faceValue: 220_000,
      allocation: 50,
      resale: {
        mode: 'capped',
        maxPriceBps: 11_000,
        minPriceBps: 5_000,
        opensAt: T0,
        closesAt: DOORS - 6 * HOUR,
        cooldownMs: 0,
        maxResalesPerTicket: 2,
        maxActiveListingsPerIdentity: 2,
        splits: { organizerBps: 700, platformBps: 300, rightsHolderBps: 200 },
      },
    },
  ],
};

/** Mints `upTo` tickets, then breaks — the shape of a batch that half-lands. */
class HalfChain extends FakeChain {
  constructor(private readonly upTo: number) {
    super();
  }
  override async mintBatch(requests: readonly MintRequest[]): Promise<readonly MintReceipt[]> {
    const done = await super.mintBatch(requests.slice(0, this.upTo));
    const next = requests[this.upTo];
    if (!next) return done;
    throw new PartialBatch(done, next.ticketId, new ChainUnavailable('sequencer went away'));
  }
}

/** A chain that takes its time, so two drains genuinely overlap. */
class SlowChain extends FakeChain {
  constructor(private readonly delayMs = 20) {
    super();
  }
  override async mintBatch(requests: readonly MintRequest[]): Promise<readonly MintReceipt[]> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return super.mintBatch(requests);
  }
}

async function buyTicket(): Promise<string> {
  const identityId = (await post('/v1/identities', {})).json().identityId as string;
  const order = await post('/v1/orders', { identityId, tierId: 'tier_ga', quantity: 1 });
  const paid = await post(`/v1/orders/${order.json().orderId}/pay`, {});
  expect(paid.statusCode).toBe(201);
  return paid.json().tickets[0] as string;
}

async function start(chain: FakeChain): Promise<void> {
  clock = T0;
  app = buildApp({ now, devMode: true, chain });
  await app.server.ready();
  expect((await post('/v1/events', { event: EVENT })).statusCode).toBe(201);
}

afterEach(async () => {
  await app.server.close();
  app.db.close();
});

describe('the outbox claims work before doing it', () => {
  beforeEach(async () => {
    await start(new FakeChain());
  });

  it('hands the same row to one caller only', async () => {
    await buyTicket();

    const first = app.repo.outbox.claimPending('mint', 50, now());
    const second = app.repo.outbox.claimPending('mint', 50, now());

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // the claim is the whole point
    expect(first[0]?.state).toBe('submitted');
  });

  it('releases a failed row so it retries', async () => {
    await buyTicket();
    const [row] = app.repo.outbox.claimPending('mint', 50, now());
    expect(row).toBeDefined();

    app.repo.outbox.markFailed(row!.op_id, 'sequencer down');
    // Failure is a definite answer: nothing landed, so it is safe to try again.
    expect(app.repo.outbox.claimPending('mint', 50, now())).toHaveLength(1);
  });
});

describe('a restart puts back what it never sent', () => {
  let chain: FakeChain;

  beforeEach(async () => {
    chain = new FakeChain();
    await start(chain);
  });

  it('releases a claim that never reached the chain', async () => {
    await buyTicket();
    const [row] = app.repo.outbox.claimPending('mint', 50, now());
    expect(row?.state).toBe('submitted');
    expect(row?.tx_hash).toBeNull();

    // The process dies here. Nothing was signed and nothing was broadcast, so
    // the work is free to replay — and must, or every deploy that lands mid
    // drain silently strands whatever was in flight.
    expect(app.repo.outbox.releaseUnsent()).toBe(1);
    expect(app.repo.outbox.claimPending('mint', 50, now())).toHaveLength(1);
  });

  it('leaves a claim that did reach the chain exactly where it is', async () => {
    await buyTicket();
    chain.uncertainNext(1);
    await app.tokens!.drainMints();

    // This one has a hash: it was sent, it may confirm, and replaying it would
    // mint a second token for the seat.
    expect(app.repo.outbox.releaseUnsent()).toBe(0);
    expect(app.repo.outbox.claimPending('mint', 50, now())).toHaveLength(0);
    expect(app.tokens!.status().submitted).toBe(1);
  });
});

describe('two overlapping drains mint one token', () => {
  beforeEach(async () => {
    await start(new SlowChain(25));
  });

  it('does not put two tokens in circulation for one seat', async () => {
    const ticketId = await buyTicket();
    // Both start before either finishes — the exact shape of a drain that
    // outruns its own timer.
    const [a, b] = await Promise.all([app.tokens!.drainMints(), app.tokens!.drainMints()]);

    const confirmed = a.confirmed + b.confirmed;
    expect(confirmed).toBe(1);
    expect(a.attempted + b.attempted).toBe(1); // the second found nothing to do

    const status = app.tokens!.status();
    expect(status.confirmed).toBe(1);
    expect(status.pending).toBe(0);
    expect(app.repo.outbox.tokenIdFor(ticketId)).toBeDefined();
  });
});

describe('a batch that half-lands keeps what landed', () => {
  beforeEach(async () => {
    await start(new HalfChain(1));
  });

  it('confirms the minted ticket and retries only the rest', async () => {
    const first = await buyTicket();
    const second = await buyTicket();

    const result = await app.tokens!.drainMints();
    expect(result.attempted).toBe(2);
    expect(result.confirmed).toBe(1);

    // The one that minted is recorded, so a retry cannot mint it again.
    expect(app.repo.outbox.tokenIdFor(first)).toBeDefined();
    expect(app.repo.outbox.tokenIdFor(second)).toBeUndefined();

    // And only the unminted one is still queued.
    const claimed = app.repo.outbox.claimPending('mint', 50, now());
    expect(claimed).toHaveLength(1);
    expect(JSON.parse(claimed[0]!.payload).ticketId).toBe(second);
  });
});

describe('a transaction whose fate is unknown is never retried', () => {
  let chain: FakeChain;

  beforeEach(async () => {
    chain = new FakeChain();
    await start(chain);
  });

  it('holds the row rather than minting a second token', async () => {
    await buyTicket();

    // Sent, then no receipt. It may yet confirm.
    chain.uncertainNext(1);
    const first = await app.tokens!.drainMints();
    expect(first.confirmed).toBe(0);
    expect(first.errors[0]).toMatch(/unknown/);

    // The critical assertion: the next drain must not try again.
    clock = T0 + 60_000;
    const second = await app.tokens!.drainMints();
    expect(second.attempted).toBe(0);
    expect(chain.calls.mintBatch).toBe(1);
    expect(chain.mintedCount).toBe(0);

    // And it is visible, because stranded work that nobody sees is worse than
    // stranded work that pages somebody.
    const status = app.tokens!.status();
    expect(status.submitted).toBe(1);
    expect(status.oldestSubmittedAt).toBe(T0);

    const reported = (await post('/v1/chain/drain')).json();
    expect(reported.mints.attempted).toBe(0);
  });

  it('still retries an ordinary failure', async () => {
    await buyTicket();

    chain.failNext(1);
    expect((await app.tokens!.drainMints()).confirmed).toBe(0);

    clock = T0 + 60_000;
    const retry = await app.tokens!.drainMints();
    expect(retry.attempted).toBe(1);
    expect(retry.confirmed).toBe(1);
  });

  it('distinguishes the two by what actually left the process', () => {
    // The type carries the distinction, so a caller cannot accidentally treat a
    // sent transaction as a failed one.
    const uncertain = new ChainUncertain('0xabc', 'timed out');
    expect(uncertain.txHash).toBe('0xabc');
    expect(uncertain.name).toBe('ChainUncertain');
  });
});
