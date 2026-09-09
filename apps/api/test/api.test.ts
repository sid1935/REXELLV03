import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE, epochMs } from '@rexell/domain';
import type { EpochMs, EventDef } from '@rexell/domain';
import { buildApp } from '../src/app.js';
import type { App } from '../src/app.js';
import { HOLD_TTL_MS } from '../src/routes/commerce.js';

const T0 = 1_780_000_000_000;
const DOORS = T0 + 30 * DAY;

let app: App;
let clock = T0;
const now = (): EpochMs => epochMs(clock);

/** A small event, so tests can exhaust inventory without ten thousand requests. */
function eventPayload(overrides: Partial<EventDef> = {}) {
  return {
    id: 'evt_test',
    organizerId: 'org_test',
    name: 'Test Festival',
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
        eventId: 'evt_test',
        name: 'General Admission',
        faceValue: 220_000,
        allocation: 10,
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
      {
        id: 'tier_vip',
        eventId: 'evt_test',
        name: 'VIP',
        faceValue: 850_000,
        allocation: 5,
        resale: {
          mode: 'bound',
          maxPriceBps: 10_000,
          minPriceBps: 10_000,
          opensAt: T0,
          closesAt: DOORS,
          cooldownMs: 0,
          maxResalesPerTicket: 0,
          maxActiveListingsPerIdentity: 0,
          splits: { organizerBps: 0, platformBps: 0, rightsHolderBps: 0 },
        },
      },
    ],
    ...overrides,
  };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return app.server.inject({ method: 'POST', url, payload: body as object, headers });
}
async function get(url: string) {
  return app.server.inject({ method: 'GET', url });
}

async function newIdentity(opts: { enrolled?: boolean; ageYears?: number } = {}): Promise<string> {
  const r = await post('/v1/identities', opts);
  return r.json().identityId as string;
}

/** Buy and pay in one go, returning the ticket id. */
async function buyTicket(identityId: string, tierId = 'tier_ga'): Promise<string> {
  const order = await post('/v1/orders', { identityId, tierId, quantity: 1 });
  expect(order.statusCode).toBe(201);
  const paid = await post(`/v1/orders/${order.json().orderId}/pay`, {});
  expect(paid.statusCode).toBe(201);
  return paid.json().tickets[0] as string;
}

beforeEach(async () => {
  clock = T0;
  app = buildApp({ now });
  await app.server.ready();
  const created = await post('/v1/events', { event: eventPayload() });
  expect(created.statusCode).toBe(201);
});

afterEach(async () => {
  await app.server.close();
  app.db.close();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('events', () => {
  it('creates an event and reports a stable policy hash', async () => {
    const a = await get('/v1/events/evt_test');
    expect(a.statusCode).toBe(200);
    expect(a.json().policyHash).toMatch(/^[0-9a-f]{64}$/);

    // Same terms, different name → same hash. The hash commits to the deal, not
    // the marketing copy.
    const second = buildApp({ now });
    await second.server.ready();
    const renamed = {
      ...eventPayload(),
      id: 'evt_other',
      name: 'Renamed',
      tiers: eventPayload().tiers.map((t) => ({ ...t, eventId: 'evt_other' })),
    };
    const createdOther = await second.server.inject({ method: 'POST', url: '/v1/events', payload: { event: renamed } });
    expect(createdOther.statusCode).toBe(201);
    const b = await second.server.inject({ method: 'GET', url: '/v1/events/evt_other' });
    expect(b.json().policyHash).toBe(a.json().policyHash);
    await second.server.close();
    second.db.close();
  });

  it('refuses an event that oversells its own capacity', async () => {
    const bad = await post('/v1/events', {
      event: { ...eventPayload(), id: 'evt_bad', capacity: 5, tiers: eventPayload().tiers },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_POLICY');
  });
});

describe('the exit criterion: a ticket sold and read back over HTTP', () => {
  it('sells a ticket end to end', async () => {
    const alice = await newIdentity();

    const order = await post('/v1/orders', { identityId: alice, tierId: 'tier_ga', quantity: 2 });
    expect(order.statusCode).toBe(201);
    expect(order.json().amountMinor).toBe(440_000);

    const paid = await post(`/v1/orders/${order.json().orderId}/pay`, { authRef: 'auth_1' });
    expect(paid.statusCode).toBe(201);
    expect(paid.json().tickets).toHaveLength(2);

    const mine = await get(`/v1/identities/${alice}/tickets`);
    expect(mine.json().tickets).toHaveLength(2);
    expect(mine.json().tickets[0].state).toBe('issued');

    const event = await get('/v1/events/evt_test');
    const ga = event.json().tiers.find((t: { id: string }) => t.id === 'tier_ga');
    expect(ga.sold).toBe(2);
    expect(ga.held).toBe(0);
    expect(ga.remaining).toBe(8);
  });
});

describe('the exit criterion: contention cannot oversell', () => {
  it('lets exactly `allocation` reservations through and no more', async () => {
    // Ten seats, twenty-five buyers, one at a time as fast as the process allows.
    // The guard is the conditional UPDATE in reserve(), so this fails loudly if
    // anyone ever "optimises" it into a read-then-write.
    const buyers = await Promise.all(Array.from({ length: 25 }, () => newIdentity()));
    const results = await Promise.all(
      buyers.map((identityId) => post('/v1/orders', { identityId, tierId: 'tier_ga', quantity: 1 })),
    );

    const created = results.filter((r) => r.statusCode === 201);
    const soldOut = results.filter((r) => r.statusCode === 409);

    expect(created).toHaveLength(10);
    expect(soldOut).toHaveLength(15);
    expect(soldOut.every((r) => r.json().error.code === 'SOLD_OUT')).toBe(true);

    const event = await get('/v1/events/evt_test');
    const ga = event.json().tiers.find((t: { id: string }) => t.id === 'tier_ga');
    expect(ga.held).toBe(10);
    expect(ga.sold + ga.held).toBeLessThanOrEqual(ga.allocation);
  });

  it('never lets the last seat go twice', async () => {
    const nine = await Promise.all(Array.from({ length: 9 }, () => newIdentity()));
    for (const id of nine) expect((await post('/v1/orders', { identityId: id, tierId: 'tier_ga', quantity: 1 })).statusCode).toBe(201);

    const [a, b] = await Promise.all([newIdentity(), newIdentity()]);
    const race = await Promise.all([
      post('/v1/orders', { identityId: a, tierId: 'tier_ga', quantity: 1 }),
      post('/v1/orders', { identityId: b, tierId: 'tier_ga', quantity: 1 }),
    ]);
    expect(race.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(race.filter((r) => r.statusCode === 409)).toHaveLength(1);
  });
});

describe('the exit criterion: writes are idempotent under retry', () => {
  it('returns the first response for a repeated key, and creates nothing new', async () => {
    const alice = await newIdentity();
    const key = 'idem-order-1';

    const first = await post('/v1/orders', { identityId: alice, tierId: 'tier_ga', quantity: 1 }, { 'idempotency-key': key });
    const second = await post('/v1/orders', { identityId: alice, tierId: 'tier_ga', quantity: 1 }, { 'idempotency-key': key });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().orderId).toBe(first.json().orderId);
    expect(second.headers['idempotent-replay']).toBe('true');

    // One hold, not two. This is the whole point.
    const event = await get('/v1/events/evt_test');
    expect(event.json().tiers.find((t: { id: string }) => t.id === 'tier_ga').held).toBe(1);
  });

  it('refuses a reused key carrying a different request', async () => {
    const [alice, bob] = await Promise.all([newIdentity(), newIdentity()]);
    const key = 'idem-order-2';
    await post('/v1/orders', { identityId: alice, tierId: 'tier_ga', quantity: 1 }, { 'idempotency-key': key });
    const clash = await post('/v1/orders', { identityId: bob, tierId: 'tier_ga', quantity: 1 }, { 'idempotency-key': key });

    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('does not cache a failure, so a retry can succeed once inventory frees up', async () => {
    // Fill the tier, then fail a purchase under a key.
    const hogs = await Promise.all(Array.from({ length: 10 }, () => newIdentity()));
    for (const id of hogs) await post('/v1/orders', { identityId: id, tierId: 'tier_ga', quantity: 1 });

    const late = await newIdentity();
    const key = 'idem-order-3';
    const failed = await post('/v1/orders', { identityId: late, tierId: 'tier_ga', quantity: 1 }, { 'idempotency-key': key });
    expect(failed.statusCode).toBe(409);

    // Holds expire, inventory comes back, and the same key is retryable.
    clock = T0 + HOLD_TTL_MS + 1 * MINUTE;
    const retried = await post('/v1/orders', { identityId: late, tierId: 'tier_ga', quantity: 1 }, { 'idempotency-key': key });
    expect(retried.statusCode).toBe(201);
  });
});

describe('holds', () => {
  it('gives inventory back when a hold runs out', async () => {
    const alice = await newIdentity();
    await post('/v1/orders', { identityId: alice, tierId: 'tier_ga', quantity: 3 });

    let ga = (await get('/v1/events/evt_test')).json().tiers[0];
    expect(ga.held).toBe(3);
    expect(ga.remaining).toBe(7);

    clock = T0 + HOLD_TTL_MS + 1;
    ga = (await get('/v1/events/evt_test')).json().tiers[0];
    expect(ga.held).toBe(0);
    expect(ga.remaining).toBe(10);
  });

  it('refuses to pay against a hold that already expired', async () => {
    const alice = await newIdentity();
    const order = await post('/v1/orders', { identityId: alice, tierId: 'tier_ga', quantity: 1 });

    clock = T0 + HOLD_TTL_MS + 1;
    const paid = await post(`/v1/orders/${order.json().orderId}/pay`, {});
    expect(paid.statusCode).toBe(409);
    expect(paid.json().error.code).toBe('HOLD_EXPIRED');
  });
});

describe('purchase rules are enforced at the edge, not just in the domain', () => {
  it('blocks an unenrolled buyer', async () => {
    const ghost = await newIdentity({ enrolled: false });
    const r = await post('/v1/orders', { identityId: ghost, tierId: 'tier_ga', quantity: 1 });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('NOT_ENROLLED');
  });

  it('holds the per-identity limit across separate orders', async () => {
    const alice = await newIdentity();
    await buyTicket(alice);
    await buyTicket(alice);
    await buyTicket(alice);
    await buyTicket(alice);

    const fifth = await post('/v1/orders', { identityId: alice, tierId: 'tier_ga', quantity: 1 });
    expect(fifth.statusCode).toBe(409);
    expect(fifth.json().error.code).toBe('PURCHASE_LIMIT_REACHED');
  });
});

describe('resale', () => {
  it('runs a capped resale and splits the money exactly', async () => {
    const [alice, bob] = await Promise.all([newIdentity(), newIdentity()]);
    const ticketId = await buyTicket(alice);

    const listed = await post('/v1/listings', { ticketId, identityId: alice, priceMinor: 242_000 });
    expect(listed.statusCode).toBe(201);
    expect(listed.json().ceilingMinor).toBe(242_000);

    const bought = await post(`/v1/listings/${listed.json().listingId}/buy`, {
      buyerIdentityId: bob,
      expectedPriceMinor: 242_000,
    });
    expect(bought.statusCode).toBe(201);

    // The worked example from the business plan, to the paisa.
    expect(bought.json().split).toEqual({
      organizerMinor: 16_940,
      platformMinor: 7_260,
      rightsHolderMinor: 4_840,
      sellerMinor: 212_960,
    });

    // Ownership moved.
    expect((await get(`/v1/identities/${alice}/tickets`)).json().tickets).toHaveLength(0);
    const bobTickets = (await get(`/v1/identities/${bob}/tickets`)).json().tickets;
    expect(bobTickets).toHaveLength(1);
    expect(bobTickets[0].resaleCount).toBe(1);

    const settlement = (await get('/v1/events/evt_test/settlement')).json();
    expect(settlement.resales).toBe(1);
    expect(settlement.organizerMinor).toBe(16_940);
  });

  it('rejects a listing above the ceiling', async () => {
    const alice = await newIdentity();
    const ticketId = await buyTicket(alice);
    const r = await post('/v1/listings', { ticketId, identityId: alice, priceMinor: 242_001 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('PRICE_ABOVE_CEILING');
  });

  it('refuses to list a bound ticket at any price', async () => {
    const alice = await newIdentity();
    const ticketId = await buyTicket(alice, 'tier_vip');
    const r = await post('/v1/listings', { ticketId, identityId: alice, priceMinor: 850_000 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('RESALE_DISABLED');
  });

  it('sells a listing to exactly one of two simultaneous buyers', async () => {
    const [alice, bob, carol] = await Promise.all([newIdentity(), newIdentity(), newIdentity()]);
    const ticketId = await buyTicket(alice);
    const listed = await post('/v1/listings', { ticketId, identityId: alice, priceMinor: 230_000 });
    const id = listed.json().listingId;

    const race = await Promise.all([
      post(`/v1/listings/${id}/buy`, { buyerIdentityId: bob, expectedPriceMinor: 230_000 }),
      post(`/v1/listings/${id}/buy`, { buyerIdentityId: carol, expectedPriceMinor: 230_000 }),
    ]);
    expect(race.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(race.filter((r) => r.statusCode === 409)).toHaveLength(1);

    // Exactly one settlement, so the organizer is paid once.
    expect((await get('/v1/events/evt_test/settlement')).json().resales).toBe(1);
  });

  it('refuses when the price moved under the buyer', async () => {
    const [alice, bob] = await Promise.all([newIdentity(), newIdentity()]);
    const ticketId = await buyTicket(alice);
    const listed = await post('/v1/listings', { ticketId, identityId: alice, priceMinor: 242_000 });
    const r = await post(`/v1/listings/${listed.json().listingId}/buy`, {
      buyerIdentityId: bob,
      expectedPriceMinor: 220_000,
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('PRICE_CHANGED');
  });
});

describe('the gate', () => {
  it('builds a manifest and never puts a template in it', async () => {
    const alice = await newIdentity();
    await buyTicket(alice);

    const m = (await get('/v1/events/evt_test/manifest')).json();
    expect(m.count).toBe(1);
    expect(m.entries[0].identityId).toBe(alice);
    // A pointer, resolved by the vault. Not bytes.
    expect(m.entries[0].templateRef).toMatch(/^tpl:/);
    expect(JSON.stringify(m)).not.toMatch(/embedding|descriptor|vector/i);
  });

  it('emits a rebind delta on resale so the seller stops opening the gate', async () => {
    const [alice, bob] = await Promise.all([newIdentity(), newIdentity()]);
    const ticketId = await buyTicket(alice);
    const before = (await get('/v1/events/evt_test/deltas?since=0')).json();

    const listed = await post('/v1/listings', { ticketId, identityId: alice, priceMinor: 230_000 });
    await post(`/v1/listings/${listed.json().listingId}/buy`, {
      buyerIdentityId: bob,
      expectedPriceMinor: 230_000,
    });

    const after = (await get(`/v1/events/evt_test/deltas?since=${before.serverSequence}`)).json();
    const rebind = after.deltas.find((d: { kind: string }) => d.kind === 'rebind');
    expect(rebind).toBeDefined();
    expect(rebind.ticketId).toBe(ticketId);
    expect(rebind.identityId).toBe(bob);

    // And the manifest a freshly-keyed scanner receives already reflects it.
    const m = (await get('/v1/events/evt_test/manifest')).json();
    expect(m.entries[0].identityId).toBe(bob);
  });

  it('accepts a re-uploaded attestation batch without double counting', async () => {
    const alice = await newIdentity();
    const ticketId = await buyTicket(alice);

    const batch = {
      attestations: [
        {
          ticketId,
          identityId: alice,
          lane: 'lane_a',
          decidedAt: DOORS + 5 * MINUTE,
          outcome: 'admit',
          code: 'MATCHED',
          matchScore: 0.96,
          manifestSequence: 1,
          offline: true,
        },
      ],
    };

    const first = await post('/v1/events/evt_test/attestations', batch);
    expect(first.json()).toMatchObject({ received: 1, inserted: 1, duplicates: 0 });

    const replay = await post('/v1/events/evt_test/attestations', batch);
    expect(replay.json()).toMatchObject({ received: 1, inserted: 0, duplicates: 1 });
  });

  it('reconciles a double entry across two offline lanes', async () => {
    const alice = await newIdentity();
    const ticketId = await buyTicket(alice);

    const scan = (lane: string, at: number) => ({
      ticketId,
      identityId: alice,
      lane,
      decidedAt: at,
      outcome: 'admit',
      code: 'MATCHED',
      matchScore: 0.95,
      manifestSequence: 1,
      offline: true,
    });

    await post('/v1/events/evt_test/attestations', {
      attestations: [scan('lane_a', DOORS + 60_000), scan('lane_b', DOORS + 90_000)],
    });

    const recon = (await get('/v1/events/evt_test/reconciliation')).json();
    expect(recon.scans).toBe(2);
    expect(recon.admitted).toBe(2);
    expect(recon.doubleEntries).toHaveLength(1);
    expect(recon.doubleEntries[0].ticketId).toBe(ticketId);
    // Both lanes were offline — which is the explanation, and why we record it.
    expect(recon.doubleEntries[0].lanes.every((l: { offline: boolean }) => l.offline)).toBe(true);
  });

  it('reports the fallback rate, the number the product is judged on', async () => {
    const alice = await newIdentity();
    const ticketId = await buyTicket(alice);
    await post('/v1/events/evt_test/attestations', {
      attestations: [
        { ticketId, identityId: alice, lane: 'l1', decidedAt: DOORS + 1000, outcome: 'admit', code: 'MATCHED', matchScore: 0.97, manifestSequence: 1, offline: false },
        { ticketId, identityId: alice, lane: 'l2', decidedAt: DOORS + 2000, outcome: 'fallback', code: 'NO_MATCH', matchScore: 0.2, manifestSequence: 1, offline: false },
        { ticketId, identityId: alice, lane: 'l3', decidedAt: DOORS + 3000, outcome: 'deny', code: 'CREDENTIAL_REVOKED', matchScore: 0.98, manifestSequence: 1, offline: false },
        { ticketId, identityId: alice, lane: 'l4', decidedAt: DOORS + 4000, outcome: 'admit', code: 'MATCHED', matchScore: 0.99, manifestSequence: 1, offline: false },
      ],
    });

    const recon = (await get('/v1/events/evt_test/reconciliation')).json();
    expect(recon).toMatchObject({ scans: 4, admitted: 2, denied: 1, fallback: 1, fallbackRate: 0.25 });
  });
});
