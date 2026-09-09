import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, epochMs } from '@rexell/domain';
import type { EpochMs } from '@rexell/domain';
import { buildApp } from '../src/app.js';
import type { App } from '../src/app.js';
import { FakeChain } from '../src/chain/client.js';

const T0 = 1_780_000_000_000;
const DOORS = T0 + 30 * DAY;

let app: App;
let chain: FakeChain;
let clock = T0;
const now = (): EpochMs => epochMs(clock);

const post = (url: string, body: unknown = {}) =>
  app.server.inject({ method: 'POST', url, payload: body as object });
const get = (url: string) => app.server.inject({ method: 'GET', url });

const EVENT = {
  id: 'evt_chain',
  organizerId: 'org_chain',
  name: 'Chain Test',
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
      eventId: 'evt_chain',
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

async function newIdentity(): Promise<string> {
  return (await post('/v1/identities', {})).json().identityId as string;
}

async function buyTicket(identityId: string): Promise<string> {
  const order = await post('/v1/orders', { identityId, tierId: 'tier_ga', quantity: 1 });
  expect(order.statusCode).toBe(201);
  const paid = await post(`/v1/orders/${order.json().orderId}/pay`, {});
  expect(paid.statusCode).toBe(201);
  return paid.json().tickets[0] as string;
}

beforeEach(async () => {
  clock = T0;
  chain = new FakeChain();
  app = buildApp({ now, devMode: true, chain });
  await app.server.ready();
  expect((await post('/v1/events', { event: EVENT })).statusCode).toBe(201);
});

afterEach(async () => {
  await app.server.close();
  app.db.close();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the exit criterion: tickets still sell with the chain stopped', () => {
  it('sells, resells and opens a gate with the sequencer down the whole time', async () => {
    chain.stop();
    expect((await get('/v1/chain/status')).json().chainUp).toBe(false);

    // Primary sale.
    const alice = await newIdentity();
    const ticketId = await buyTicket(alice);
    expect(ticketId).toMatch(/^tkt_/);

    // The fan can see their ticket, and it is valid.
    const mine = (await get(`/v1/identities/${alice}/tickets`)).json().tickets;
    expect(mine).toHaveLength(1);
    expect(mine[0].state).toBe('issued');

    // Resale, still with no chain.
    const bob = await newIdentity();
    const listed = await post('/v1/listings', { ticketId, identityId: alice, priceMinor: 242_000 });
    expect(listed.statusCode).toBe(201);
    const bought = await post(`/v1/listings/${listed.json().listingId}/buy`, {
      buyerIdentityId: bob,
      expectedPriceMinor: 242_000,
    });
    expect(bought.statusCode).toBe(201);
    expect(bought.json().split.organizerMinor).toBe(16_940);

    // The gate works: the manifest is built from the database, not the chain.
    const manifest = (await get('/v1/events/evt_chain/manifest')).json();
    expect(manifest.count).toBe(1);
    expect(manifest.entries[0].identityId).toBe(bob);

    // Nothing reached the chain, and the system knows exactly how far behind it is.
    expect(chain.mintedCount).toBe(0);
    const status = (await get('/v1/chain/status')).json();
    expect(status.pending).toBe(2); // one mint, one resale
    expect(status.confirmed).toBe(0);
  });

  it('catches up when the chain comes back, without anyone reselling anything', async () => {
    chain.stop();
    const alice = await newIdentity();
    const ticketId = await buyTicket(alice);

    // A drain attempt while down changes nothing but the attempt count.
    const whileDown = (await post('/v1/chain/drain')).json();
    expect(whileDown.mints.confirmed).toBe(0);
    expect(whileDown.mints.failed).toBe(1);

    chain.start();
    clock = T0 + 60_000;
    const afterUp = (await post('/v1/chain/drain')).json();
    expect(afterUp.mints.confirmed).toBe(1);

    expect(chain.tokenIdFor(ticketId)).toBeDefined();
    const status = (await get('/v1/chain/status')).json();
    expect(status.pending).toBe(0);
    expect(status.confirmed).toBe(1);
  });

  it('reports how far behind the ledger is, which is the thing to alert on', async () => {
    chain.stop();
    await buyTicket(await newIdentity());

    clock = T0 + 45 * 60_000;
    const status = (await get('/v1/chain/status')).json();
    expect(status.chainUp).toBe(false);
    expect(status.oldestPendingAgeMs).toBe(45 * 60_000);
  });
});

describe('minting is batched and idempotent', () => {
  it('mints many tickets in one chain call', async () => {
    // One transaction per ticket is a bad trade at onsale volume.
    for (let i = 0; i < 8; i += 1) await buyTicket(await newIdentity());

    const result = (await post('/v1/chain/drain')).json();
    expect(result.mints.confirmed).toBe(8);
    expect(chain.calls.mintBatch).toBe(1);
    expect(chain.mintedCount).toBe(8);
  });

  it('never mints the same ticket twice, however often the drain runs', async () => {
    const ticketId = await buyTicket(await newIdentity());

    await post('/v1/chain/drain');
    await post('/v1/chain/drain');
    await post('/v1/chain/drain');

    expect(chain.mintedCount).toBe(1);
    expect(chain.tokenIdFor(ticketId)).toBe('1');
    expect((await get('/v1/chain/status')).json().confirmed).toBe(1);
  });

  it('records the token id and mint state on the ticket', async () => {
    const ticketId = await buyTicket(await newIdentity());
    await post('/v1/chain/drain');

    const row = app.db.get<{ token_id: string; mint_state: string }>(
      'SELECT token_id, mint_state FROM tickets WHERE ticket_id = ?',
      ticketId,
    );
    expect(row?.mint_state).toBe('confirmed');
    expect(row?.token_id).toBe('1');
  });

  it('retries a transient revert on the next pass', async () => {
    await buyTicket(await newIdentity());
    chain.failNext(1);

    const first = (await post('/v1/chain/drain')).json();
    expect(first.mints.confirmed).toBe(0);
    expect(first.mints.errors[0]).toMatch(/reverted/);

    const second = (await post('/v1/chain/drain')).json();
    expect(second.mints.confirmed).toBe(1);
  });

  it('leaves the ticket entirely usable while its mint is stuck', async () => {
    const alice = await newIdentity();
    const ticketId = await buyTicket(alice);
    chain.stop();
    await post('/v1/chain/drain');

    // Unminted, and completely fine.
    const row = app.db.get<{ mint_state: string }>('SELECT mint_state FROM tickets WHERE ticket_id = ?', ticketId);
    expect(row?.mint_state).toBe('pending');

    const manifest = (await get('/v1/events/evt_chain/manifest')).json();
    expect(manifest.entries.map((e: { ticketId: string }) => e.ticketId)).toContain(ticketId);
  });
});

describe('resale settlement reaches the chain separately', () => {
  it('enqueues and confirms a resale record', async () => {
    const alice = await newIdentity();
    const bob = await newIdentity();
    const ticketId = await buyTicket(alice);

    const listed = await post('/v1/listings', { ticketId, identityId: alice, priceMinor: 242_000 });
    await post(`/v1/listings/${listed.json().listingId}/buy`, {
      buyerIdentityId: bob,
      expectedPriceMinor: 242_000,
    });

    const result = (await post('/v1/chain/drain')).json();
    expect(result.mints.confirmed).toBe(1);
    expect(result.resales.confirmed).toBe(1);
    expect(chain.calls.recordResale).toBe(1);
  });
});

describe('with no chain configured at all', () => {
  it('still sells tickets, and says so plainly', async () => {
    const noChain = buildApp({ now, devMode: true });
    await noChain.server.ready();
    await noChain.server.inject({ method: 'POST', url: '/v1/events', payload: { event: EVENT } });

    const id = (await noChain.server.inject({ method: 'POST', url: '/v1/identities', payload: {} })).json()
      .identityId;
    const order = await noChain.server.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { identityId: id, tierId: 'tier_ga', quantity: 1 },
    });
    expect(order.statusCode).toBe(201);

    const status = await noChain.server.inject({ method: 'GET', url: '/v1/chain/status' });
    expect(status.json()).toEqual({ configured: false });

    await noChain.server.close();
    noChain.db.close();
  });
});
