import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, epochMs } from '@rexell/domain';
import type { EpochMs } from '@rexell/domain';
import { buildApp } from '../src/app.js';
import type { App } from '../src/app.js';
import { FakeChain } from '../src/chain/client.js';

/**
 * Revoking a ticket.
 *
 * Every piece of this existed before the path did. The ticket state machine has
 * had a `revoke` transition since M1; the manifest fold has applied revocation
 * deltas since M2; the gate has refused revoked tickets since M2; TicketNFT has
 * had `revoke()` since M3. Nothing connected them, so no ticket could be voided
 * by any means — no chargeback, no fraud case, no cancelled event.
 *
 * The tests below are therefore mostly about the joins rather than the parts.
 */

const T0 = 1_780_000_000_000;
const DOORS = T0 + 30 * DAY;

let app: App;
let chain: FakeChain;
let clock = T0;
const now = (): EpochMs => epochMs(clock);

const post = (url: string, body: unknown = {}, key?: string) =>
  app.server.inject({
    method: 'POST',
    url,
    payload: body as object,
    ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
  });
const get = (url: string, key?: string) =>
  app.server.inject({ method: 'GET', url, ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}) });

function eventPayload(eventId: string) {
  return {
    id: eventId,
    name: 'Revocation Test',
    capacity: 100,
    salesOpenAt: T0,
    salesCloseAt: DOORS - 2 * HOUR,
    doorsOpenAt: DOORS,
    endsAt: DOORS + 10 * HOUR,
    maxTicketsPerIdentity: 4,
    allowReentry: false,
    tiers: [
      {
        id: `${eventId}_ga`,
        eventId,
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
}

async function organizer(name: string): Promise<string> {
  return (await post('/v1/organizers', { name })).json().apiKey as string;
}

async function buyTicket(eventId: string): Promise<{ ticketId: string; identityId: string }> {
  const identityId = (await post('/v1/identities', {})).json().identityId as string;
  const order = await post('/v1/orders', { identityId, tierId: `${eventId}_ga`, quantity: 1 });
  expect(order.statusCode).toBe(201);
  const paid = await post(`/v1/orders/${order.json().orderId}/pay`, {});
  expect(paid.statusCode).toBe(201);
  return { ticketId: paid.json().tickets[0] as string, identityId };
}

const entryFor = (manifest: { entries: { ticketId: string; revoked: boolean }[] }, ticketId: string) =>
  manifest.entries.find((e) => e.ticketId === ticketId);

beforeEach(async () => {
  clock = T0;
  chain = new FakeChain();
  app = buildApp({ now, devMode: true, chain });
  await app.server.ready();
});

afterEach(async () => {
  await app.server.close();
  app.db.close();
});

describe('an organizer can void a ticket', () => {
  it('stops it opening a gate, immediately and without the chain', async () => {
    const key = await organizer('Voider');
    expect((await post('/v1/organizer/events', { event: eventPayload('evt_rev') }, key)).statusCode).toBe(201);
    const { ticketId } = await buyTicket('evt_rev');

    const before = (await get('/v1/events/evt_rev/manifest')).json();
    expect(entryFor(before, ticketId)?.revoked).toBe(false);

    chain.stop(); // the point: none of this waits on a chain
    const revoked = await post(`/v1/events/evt_rev/tickets/${ticketId}/revoke`, { reason: 'chargeback' }, key);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().state).toBe('revoked');

    // The gate reads the manifest, and the manifest has already changed.
    const after = (await get('/v1/events/evt_rev/manifest')).json();
    expect(entryFor(after, ticketId)?.revoked).toBe(true);

    // And a lane already holding an older manifest is told, rather than having
    // to re-download one.
    const deltas = (await get(`/v1/events/evt_rev/deltas?since=${before.sequence}`)).json();
    expect(deltas.deltas.some((d: { kind: string }) => d.kind === 'revoke')).toBe(true);
  });

  it('requires a reason, because an unexplained revocation is not auditable', async () => {
    const key = await organizer('Reasoner');
    await post('/v1/organizer/events', { event: eventPayload('evt_reason') }, key);
    const { ticketId } = await buyTicket('evt_reason');

    const blank = await post(`/v1/events/evt_reason/tickets/${ticketId}/revoke`, { reason: '   ' }, key);
    expect(blank.statusCode).toBe(400);
  });

  it('refuses to revoke the same ticket twice', async () => {
    const key = await organizer('Twice');
    await post('/v1/organizer/events', { event: eventPayload('evt_twice') }, key);
    const { ticketId } = await buyTicket('evt_twice');

    expect(
      (await post(`/v1/events/evt_twice/tickets/${ticketId}/revoke`, { reason: 'fraud' }, key)).statusCode,
    ).toBe(200);
    const again = await post(`/v1/events/evt_twice/tickets/${ticketId}/revoke`, { reason: 'fraud' }, key);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('will not let one organizer void the ticket of another', async () => {
    const alice = await organizer('Alice');
    const bob = await organizer('Bob');
    await post('/v1/organizer/events', { event: eventPayload('evt_alice_r') }, alice);
    await post('/v1/organizer/events', { event: eventPayload('evt_bob_r') }, bob);
    const { ticketId } = await buyTicket('evt_alice_r');

    // Bob owns an event, so the ownership check on his own event passes; the
    // ticket belonging to Alice's event is what must stop him.
    const crossEvent = await post(`/v1/events/evt_bob_r/tickets/${ticketId}/revoke`, { reason: 'mine now' }, bob);
    expect(crossEvent.statusCode).toBe(404);

    // And he cannot reach it through Alice's event either.
    const crossOrganizer = await post(
      `/v1/events/evt_alice_r/tickets/${ticketId}/revoke`,
      { reason: 'mine now' },
      bob,
    );
    expect(crossOrganizer.statusCode).toBe(404);

    const manifest = (await get('/v1/events/evt_alice_r/manifest')).json();
    expect(entryFor(manifest, ticketId)?.revoked).toBe(false);
  });

  it('refuses an unauthenticated caller', async () => {
    const key = await organizer('Guarded');
    await post('/v1/organizer/events', { event: eventPayload('evt_guarded') }, key);
    const { ticketId } = await buyTicket('evt_guarded');

    const anon = await post(`/v1/events/evt_guarded/tickets/${ticketId}/revoke`, { reason: 'x' });
    expect(anon.statusCode).toBe(401);
  });
});

describe('the revocation reaches the chain, eventually', () => {
  it('waits for the mint, then confirms', async () => {
    const key = await organizer('Drainer');
    await post('/v1/organizer/events', { event: eventPayload('evt_drain') }, key);
    const { ticketId } = await buyTicket('evt_drain');

    // Revoked before the mint has confirmed, which is the ordinary case: a
    // chargeback can land within seconds of the sale.
    expect(
      (await post(`/v1/events/evt_drain/tickets/${ticketId}/revoke`, { reason: 'chargeback' }, key)).statusCode,
    ).toBe(200);

    // There is no token to void yet, so the row waits rather than failing for
    // good or voiding token zero.
    chain.stop();
    const early = (await post('/v1/chain/drain')).json();
    expect(early.revocations.confirmed).toBe(0);
    expect(chain.isRevoked(ticketId)).toBe(false);

    chain.start();
    clock = T0 + 60_000;
    const caught = (await post('/v1/chain/drain')).json();
    expect(caught.mints.confirmed).toBe(1);
    expect(caught.revocations.confirmed).toBe(1);
    expect(chain.isRevoked(ticketId)).toBe(true);

    const status = (await get('/v1/chain/status')).json();
    expect(status.pending).toBe(0);
  });

  it('enqueues a revocation exactly once', async () => {
    const key = await organizer('Once');
    await post('/v1/organizer/events', { event: eventPayload('evt_once') }, key);
    const { ticketId } = await buyTicket('evt_once');

    await post('/v1/chain/drain'); // land the mint first
    expect((await post(`/v1/events/evt_once/tickets/${ticketId}/revoke`, { reason: 'fraud' }, key)).statusCode).toBe(
      200,
    );
    // The second attempt is refused by the state machine, so it cannot enqueue
    // a duplicate — but the outbox's unique index is the backstop either way.
    await post(`/v1/events/evt_once/tickets/${ticketId}/revoke`, { reason: 'fraud' }, key);

    const drained = (await post('/v1/chain/drain')).json();
    expect(drained.revocations.attempted).toBe(1);
    expect(chain.calls.revoke).toBe(1);
  });
});
