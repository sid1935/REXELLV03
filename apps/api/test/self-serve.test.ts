import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, epochMs } from '@rexell/domain';
import type { EpochMs } from '@rexell/domain';
import { GateEngine, generateDeviceKey, openManifest } from '@rexell/gate';
import { buildVault } from '../../vault/src/app.js';
import type { VaultApp } from '../../vault/src/app.js';
import { capture, face } from '../../vault/test/helpers.js';
import { buildApp } from '../src/app.js';
import type { App } from '../src/app.js';
import { FakeChain } from '../src/chain/client.js';
import { httpVaultClient } from '../src/vault-client.js';

/**
 * The margin proof.
 *
 * M6's exit criterion is that an event runs end to end with nobody from ReXell
 * involved. This test is that claim, executed: it signs up, provisions itself,
 * sells, resells, runs a gate and reconciles its own settlement, and the only
 * credential it ever holds is the API key its own signup returned.
 */

const T0 = 1_780_000_000_000;
const DOORS = T0 + 30 * DAY;
const ENDS = DOORS + 10 * HOUR;
const VAULT_TOKEN = 'self-serve-token';

let clock = T0;
const now = (): EpochMs => epochMs(clock);

let vault: VaultApp;
let vaultUrl: string;
let app: App;
let chain: FakeChain;

const post = (url: string, body: unknown = {}, key?: string) =>
  app.server.inject({
    method: 'POST',
    url,
    payload: body as object,
    ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
  });
const get = (url: string, key?: string) =>
  app.server.inject({ method: 'GET', url, ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}) });
const del = (url: string, key: string) =>
  app.server.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${key}` } });

function eventPayload(eventId: string) {
  return {
    id: eventId,
    name: 'Self-Serve Festival',
    capacity: 200,
    salesOpenAt: T0,
    salesCloseAt: DOORS - 2 * HOUR,
    doorsOpenAt: DOORS,
    endsAt: ENDS,
    maxTicketsPerIdentity: 4,
    allowReentry: false,
    tiers: [
      {
        id: `${eventId}_ga`,
        eventId,
        name: 'General Admission',
        faceValue: 220_000,
        allocation: 150,
        resale: {
          mode: 'capped',
          maxPriceBps: 11_000,
          minPriceBps: 5_000,
          opensAt: T0,
          closesAt: ENDS,
          cooldownMs: 0,
          maxResalesPerTicket: 2,
          maxActiveListingsPerIdentity: 2,
          splits: { organizerBps: 700, platformBps: 300, rightsHolderBps: 200 },
        },
      },
    ],
  };
}

/** A fan: identity, consent, enrolment, ticket. No organizer credentials needed. */
async function fan(seed: number, tierId: string) {
  const identityId = (await post('/v1/identities', {})).json().identityId as string;
  await post(`/v1/identities/${identityId}/consents`, { purposes: ['biometric_enrolment'] });
  const challenge = (await post(`/v1/identities/${identityId}/enrolment/challenge`)).json();
  await post(`/v1/identities/${identityId}/enrolment`, {
    scope: 'global',
    vector: [...capture(face(seed), 0.15)],
    liveness: { challengeId: challenge.id, nonce: challenge.nonce, passiveScore: 0.97, actionCompleted: true },
  });
  const order = await post('/v1/orders', { identityId, tierId, quantity: 1 });
  const paid = await post(`/v1/orders/${order.json().orderId}/pay`, {});
  return { identityId, ticketId: paid.json().tickets[0] as string };
}

beforeAll(async () => {
  vault = buildVault({
    masterKey: randomBytes(32),
    receiptKey: randomBytes(32),
    manifestKey: randomBytes(32),
    serviceToken: VAULT_TOKEN,
    now: () => clock,
  });
  await vault.server.listen({ port: 0, host: '127.0.0.1' });
  vaultUrl = `http://127.0.0.1:${vault.server.addresses()[0]?.port}`;
});

afterAll(async () => {
  await vault.server.close();
  vault.store.close();
});

beforeEach(async () => {
  clock = T0;
  chain = new FakeChain();
  app = buildApp({ now, chain, vault: httpVaultClient(vaultUrl, VAULT_TOKEN) });
  await app.server.ready();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('self-serve onboarding', () => {
  it('issues a working key from an unauthenticated signup', async () => {
    const signup = await post('/v1/organizers', { name: 'Pinewood Live', contactEmail: 'ops@pinewood.example' });
    expect(signup.statusCode).toBe(201);

    const key = signup.json().apiKey as string;
    expect(key).toMatch(/^rxl_live_/);
    expect(signup.json().warning).toMatch(/cannot be retrieved/);

    const me = await get('/v1/me', key);
    expect(me.statusCode).toBe(200);
    expect(me.json().name).toBe('Pinewood Live');
  });

  it('never stores or returns the key again', async () => {
    const signup = await post('/v1/organizers', { name: 'Once Only' });
    const key = signup.json().apiKey as string;

    // Not in the database, in any table, in any form.
    const tables = app.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((t) => t.name);
    for (const table of tables) {
      const dump = JSON.stringify(app.db.all(`SELECT * FROM ${table}`));
      expect(dump, `key found in ${table}`).not.toContain(key);
    }

    // And no route hands it back.
    const listed = await get('/v1/keys', key);
    expect(listed.json().keys[0].prefix).toMatch(/…$/);
    expect(listed.body).not.toContain(key);
  });

  it('rejects a missing, malformed or revoked key identically', async () => {
    const key = (await post('/v1/organizers', { name: 'Revoker' })).json().apiKey as string;
    const keyId = (await get('/v1/keys', key)).json().keys[0].keyId as string;

    expect((await get('/v1/me')).statusCode).toBe(401);
    expect((await get('/v1/me', 'rxl_live_nonsense')).statusCode).toBe(401);

    expect((await del(`/v1/keys/${keyId}`, key)).statusCode).toBe(200);
    const after = await get('/v1/me', key);
    expect(after.statusCode).toBe(401);
    // Same message either way: telling a caller which failure it was tells them
    // whether a guessed key exists.
    expect(after.json().error.message).toBe('That API key is not valid.');
  });

  it('will not let a key mint a more powerful key', async () => {
    const key = (await post('/v1/organizers', { name: 'Escalator' })).json().apiKey as string;
    const readOnly = (await post('/v1/keys', { name: 'read', scopes: ['analytics:read'] }, key)).json()
      .apiKey as string;

    const attempt = await post('/v1/keys', { name: 'write', scopes: ['events:write'] }, readOnly);
    expect(attempt.statusCode).toBe(403);
    expect(attempt.json().error.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('enforces scopes on the routes that need them', async () => {
    const key = (await post('/v1/organizers', { name: 'Scoped' })).json().apiKey as string;
    const readOnly = (await post('/v1/keys', { name: 'read', scopes: ['analytics:read'] }, key)).json()
      .apiKey as string;

    const created = await post('/v1/organizer/events', { event: eventPayload('evt_scoped') }, readOnly);
    expect(created.statusCode).toBe(403);
    expect(created.json().error.code).toBe('INSUFFICIENT_SCOPE');
  });
});

describe('tenancy: one organizer cannot see another', () => {
  it('hides an event it does not own, as a 404 rather than a 403', async () => {
    const alice = (await post('/v1/organizers', { name: 'Alice Promotions' })).json().apiKey as string;
    const bob = (await post('/v1/organizers', { name: 'Bob Events' })).json().apiKey as string;

    await post('/v1/organizer/events', { event: eventPayload('evt_alice') }, alice);

    // Alice can read her own.
    expect((await get('/v1/events/evt_alice/analytics', alice)).statusCode).toBe(200);

    // Bob cannot, and is not told it exists. A 403 would confirm it does.
    const peek = await get('/v1/events/evt_alice/analytics', bob);
    expect(peek.statusCode).toBe(404);
    const settlement = await get('/v1/events/evt_alice/settlement/report', bob);
    expect(settlement.statusCode).toBe(404);
  });

  it('lists only its own events', async () => {
    const alice = (await post('/v1/organizers', { name: 'Alice' })).json().apiKey as string;
    const bob = (await post('/v1/organizers', { name: 'Bob' })).json().apiKey as string;
    await post('/v1/organizer/events', { event: eventPayload('evt_a') }, alice);
    await post('/v1/organizer/events', { event: eventPayload('evt_b') }, bob);

    expect((await get('/v1/events', alice)).json().events.map((e: { id: string }) => e.id)).toEqual(['evt_a']);
    expect((await get('/v1/events', bob)).json().events.map((e: { id: string }) => e.id)).toEqual(['evt_b']);
  });

  it('will not let a caller create an event owned by somebody else', async () => {
    const bob = (await post('/v1/organizers', { name: 'Bob' })).json().apiKey as string;
    // The body carries no organizerId at all — it comes from the key.
    const created = await post(
      '/v1/organizer/events',
      { event: { ...eventPayload('evt_forged'), organizerId: 'org_alice' } },
      bob,
    );
    expect(created.statusCode).toBe(201);

    const me = await get('/v1/me', bob);
    const row = app.db.get<{ organizer_id: string }>('SELECT organizer_id FROM events WHERE event_id = ?', 'evt_forged');
    expect(row?.organizer_id).toBe(me.json().organizerId);
    expect(row?.organizer_id).not.toBe('org_alice');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the exit criterion: an event runs with nobody from ReXell involved', () => {
  it('signs up, sells, resells, admits and reconciles on one self-issued key', async () => {
    // ─ 1. An organizer signs themselves up. No ReXell action.
    const signup = await post('/v1/organizers', { name: 'Pinewood Live', contactEmail: 'ops@pinewood.example' });
    const key = signup.json().apiKey as string;
    const EVENT = 'evt_self_serve';
    const TIER = `${EVENT}_ga`;

    // ─ 2. They create the event and set the resale dials themselves.
    const created = await post('/v1/organizer/events', { event: eventPayload(EVENT) }, key);
    expect(created.statusCode).toBe(201);
    expect(created.json().tiers[0]).toMatchObject({ mode: 'capped', ceilingMinor: 242_000 });
    expect(created.json().policyHash).toMatch(/^[0-9a-f]{64}$/);

    // ─ 3. Fans buy. Nothing here touches an organizer credential.
    const fans = [];
    for (let i = 0; i < 6; i += 1) fans.push(await fan(300 + i, TIER));
    expect(fans.every((f) => f.ticketId.startsWith('tkt_'))).toBe(true);

    // ─ 4. A resale, at the ceiling the organizer set.
    const seller = fans[0]!;
    const buyer = fans[5]!;
    const listed = await post('/v1/listings', {
      ticketId: seller.ticketId,
      identityId: seller.identityId,
      priceMinor: 242_000,
    });
    expect(listed.statusCode).toBe(201);
    const sold = await post(`/v1/listings/${listed.json().listingId}/buy`, {
      buyerIdentityId: buyer.identityId,
      expectedPriceMinor: 242_000,
    });
    expect(sold.statusCode).toBe(201);

    // ─ 5. They provision their own gate, key it, and run it.
    clock = DOORS;
    const deviceKeys = generateDeviceKey();
    const registered = await post(
      '/v1/scanners',
      { scannerId: 'scn_self', eventId: EVENT, lane: 'lane_1', gateGroup: 'main', publicKeyPem: deviceKeys.publicKeyPem },
      key,
    );
    expect(registered.statusCode).toBe(201);

    const sealed = await post(`/v1/events/${EVENT}/manifest/sealed`, { scannerId: 'scn_self' }, key);
    const manifestKey = await post(`/v1/events/${EVENT}/manifest/key`, { scannerId: 'scn_self' }, key);
    const engine = new GateEngine(
      openManifest(sealed.json().sealed, Buffer.from(manifestKey.json().key, 'base64'), clock, 'scn_self'),
      {
        scannerId: 'scn_self',
        lane: 'lane_1',
        gateGroup: 'main',
        privateKeyPem: deviceKeys.privateKeyPem,
        allowReentry: false,
      },
    );

    // The night. The seller does not get in — she sold her ticket.
    //
    // She is refused as NO_MATCH rather than CREDENTIAL_REVOKED, and the
    // difference is worth understanding: this manifest was sealed after the
    // resale, so she is simply not in it. Revocation is the mechanism when a
    // ticket sells AFTER the lane was keyed, which arrives as a delta — that
    // path is covered in gate-e2e.test.ts. Two mechanisms, one outcome.
    let admitted = 0;
    for (const [i, f] of fans.entries()) {
      const decision = engine.scan(capture(face(300 + i), 0.2, 400 + i), clock).decision;
      if (decision.outcome === 'admit') admitted += 1;
      if (f === seller) {
        expect(decision.outcome).not.toBe('admit');
        expect(decision.code).toBe('NO_MATCH');
      }
    }
    // Five people, six tickets: the buyer holds two and is admitted once.
    expect(admitted).toBe(5);

    await post(`/v1/events/${EVENT}/attestations/signed`, { attestations: engine.pendingUploads() }, key);

    // ─ 6. They read their own numbers.
    const analytics = (await get(`/v1/events/${EVENT}/analytics`, key)).json();
    expect(analytics.sales.sold).toBe(6);
    expect(analytics.sales.grossMinor).toBe(6 * 220_000);
    expect(analytics.resale.completed).toBe(1);
    expect(analytics.resale.organizerCommissionMinor).toBe(16_940);
    expect(analytics.attendance.admitted).toBe(5);
    // The seller falls back rather than being denied — an unrecognised face is
    // always routed to a human, never refused outright. Her ticket is somebody
    // else's, and the desk is where that gets explained to her.
    expect(analytics.attendance.denied).toBe(0);
    expect(analytics.attendance.fallback).toBe(1);
    expect(analytics.attendance.doubleEntries).toBe(0);

    // ─ 7. And reconcile their own settlement against the chain.
    await post('/v1/chain/drain');
    const report = (await get(`/v1/events/${EVENT}/settlement/report`, key)).json();

    expect(report.resales).toBe(1);
    expect(report.reconciled).toBe(true);
    expect(report.discrepancies).toEqual([]);
    expect(report.totals.organizerMinor).toBe(16_940);
    expect(report.lines[0]).toMatchObject({ recomputed: true, balanced: true, onChain: true });
    expect(report.lines[0].txHash).toMatch(/^0x/);
    expect(report.chain.awaiting).toBe(0);

    // Every step above used one credential, and that credential came from step 1.
  });

  it('reconciles as unconfirmed rather than wrong while the chain is behind', async () => {
    const key = (await post('/v1/organizers', { name: 'Patient' })).json().apiKey as string;
    const EVENT = 'evt_lagging';
    await post('/v1/organizer/events', { event: eventPayload(EVENT) }, key);

    const a = await fan(400, `${EVENT}_ga`);
    const b = await fan(401, `${EVENT}_ga`);
    const listed = await post('/v1/listings', { ticketId: a.ticketId, identityId: a.identityId, priceMinor: 242_000 });
    await post(`/v1/listings/${listed.json().listingId}/buy`, {
      buyerIdentityId: b.identityId,
      expectedPriceMinor: 242_000,
    });

    chain.stop();
    await post('/v1/chain/drain');

    const report = (await get(`/v1/events/${EVENT}/settlement/report`, key)).json();
    // The money is correct and the organizer can be paid. The chain is simply
    // behind, which is a state, not a fault.
    expect(report.reconciled).toBe(true);
    expect(report.discrepancies).toEqual([]);
    expect(report.chain).toMatchObject({ confirmed: 0, awaiting: 1 });
    expect(report.lines[0]).toMatchObject({ recomputed: true, balanced: true, onChain: false });
  });

  it('names a tampered settlement row rather than totalling it up', async () => {
    const key = (await post('/v1/organizers', { name: 'Auditor' })).json().apiKey as string;
    const EVENT = 'evt_tamper';
    await post('/v1/organizer/events', { event: eventPayload(EVENT) }, key);

    const a = await fan(500, `${EVENT}_ga`);
    const b = await fan(501, `${EVENT}_ga`);
    const listed = await post('/v1/listings', { ticketId: a.ticketId, identityId: a.identityId, priceMinor: 242_000 });
    await post(`/v1/listings/${listed.json().listingId}/buy`, {
      buyerIdentityId: b.identityId,
      expectedPriceMinor: 242_000,
    });

    // Somebody with a SQL console shaves the organizer's share and gives it to
    // the platform. The balance CHECK still passes, so only recomputing from
    // the policy catches it.
    app.db.run(
      'UPDATE settlements SET organizer_minor = organizer_minor - 5000, platform_minor = platform_minor + 5000',
    );

    const report = (await get(`/v1/events/${EVENT}/settlement/report`, key)).json();
    expect(report.reconciled).toBe(false);
    expect(report.discrepancies[0].problem).toBe('STORED_SPLIT_DIFFERS_FROM_POLICY');
    expect(report.lines[0].recomputed).toBe(false);
    // Still balances — which is exactly why the balance check alone is not enough.
    expect(report.lines[0].balanced).toBe(true);
  });
});
