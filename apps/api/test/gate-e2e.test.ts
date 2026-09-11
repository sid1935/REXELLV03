import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE, epochMs } from '@rexell/domain';
import type { EpochMs } from '@rexell/domain';
import { GateEngine, generateDeviceKey, openManifest } from '@rexell/gate';
import { buildVault } from '../../vault/src/app.js';
import type { VaultApp } from '../../vault/src/app.js';
import { capture, face, livenessFrames } from '../../vault/test/helpers.js';
import { buildApp } from '../src/app.js';
import type { App } from '../src/app.js';
import { httpVaultClient } from '../src/vault-client.js';

/**
 * The gate, end to end: API, vault and a real scanner engine.
 *
 * The scanner here is the actual `GateEngine` from `packages/gate`, holding a
 * manifest it opened itself with a key the vault released. Nothing is stubbed
 * between the sale and the turnstile.
 */

const T0 = 1_780_000_000_000;
const DOORS = T0 + 30 * DAY;
const ENDS = DOORS + 10 * HOUR;
const VAULT_TOKEN = 'gate-e2e-token';

let clock = T0;
const now = (): EpochMs => epochMs(clock);

let vault: VaultApp;
let vaultUrl: string;
let app: App;

const EVENT = {
  id: 'evt_gate_e2e',
  organizerId: 'org_gate',
  name: 'Gate E2E',
  capacity: 100,
  salesOpenAt: T0,
  salesCloseAt: DOORS - 2 * HOUR,
  doorsOpenAt: DOORS,
  endsAt: ENDS,
  maxTicketsPerIdentity: 4,
  allowReentry: false,
  tiers: [
    {
      id: 'tier_ga',
      eventId: 'evt_gate_e2e',
      name: 'GA',
      faceValue: 220_000,
      allocation: 50,
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

const post = (url: string, body: unknown = {}) =>
  app.server.inject({ method: 'POST', url, payload: body as object });
const get = (url: string) => app.server.inject({ method: 'GET', url });

/** A fan: identity, consent, enrolment, ticket. Returns everything the test needs. */
async function fan(seed: number) {
  const identityId = (await post('/v1/identities', {})).json().identityId as string;
  await post(`/v1/identities/${identityId}/consents`, { purposes: ['biometric_enrolment'] });
  const challenge = (await post(`/v1/identities/${identityId}/enrolment/challenge`)).json();
  await post(`/v1/identities/${identityId}/enrolment`, {
    scope: 'global',
    vector: [...capture(face(seed), 0.15)],
    liveness: {
      challengeId: challenge.id,
      nonce: challenge.nonce,
      passiveScore: 0.97,
      actionCompleted: true,
      frames: livenessFrames(challenge.kind, face(seed)),
    },
  });

  const order = await post('/v1/orders', { identityId, tierId: 'tier_ga', quantity: 1 });
  const paid = await post(`/v1/orders/${order.json().orderId}/pay`, {});
  return { identityId, ticketId: paid.json().tickets[0] as string, seed };
}

/** Provision a lane and give it an opened manifest — the real key-release dance. */
async function lane(scannerId: string, laneName: string) {
  const keys = generateDeviceKey();
  const registered = await post('/v1/scanners', {
    scannerId,
    eventId: EVENT.id,
    lane: laneName,
    gateGroup: 'north',
    publicKeyPem: keys.publicKeyPem,
  });
  expect(registered.statusCode).toBe(201);

  const sealedResponse = await post(`/v1/events/${EVENT.id}/manifest/sealed`, { scannerId });
  expect(sealedResponse.statusCode).toBe(201);

  const keyResponse = await post(`/v1/events/${EVENT.id}/manifest/key`, { scannerId });
  expect(keyResponse.statusCode).toBe(200);

  const manifest = openManifest(
    sealedResponse.json().sealed,
    Buffer.from(keyResponse.json().key, 'base64'),
    clock,
    scannerId,
  );

  const engine = new GateEngine(manifest, {
    scannerId,
    lane: laneName,
    gateGroup: 'north',
    privateKeyPem: keys.privateKeyPem,
    allowReentry: false,
  });

  return { engine, keys, scannerId, sealed: sealedResponse.json() };
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
  app = buildApp({ now, vault: httpVaultClient(vaultUrl, VAULT_TOKEN) });
  await app.server.ready();
  expect((await post('/v1/events', { event: EVENT })).statusCode).toBe(201);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('manifest distribution', () => {
  it('seals early, and the blob is useless until the key window opens', async () => {
    const alice = await fan(1);
    const keys = generateDeviceKey();
    await post('/v1/scanners', {
      scannerId: 'scn_early',
      eventId: EVENT.id,
      lane: 'lane_1',
      publicKeyPem: keys.publicKeyPem,
    });

    // Three days before doors: the manifest is issued...
    clock = DOORS - 3 * DAY;
    const sealed = await post(`/v1/events/${EVENT.id}/manifest/sealed`, { scannerId: 'scn_early' });
    expect(sealed.statusCode).toBe(201);
    expect(sealed.json().included).toBe(1);
    // ...and carries no readable identity, ticket or template.
    expect(sealed.json().sealed.ciphertext).toBeTypeOf('string');
    expect(JSON.stringify(sealed.json().sealed)).not.toContain(alice.identityId);
    expect(JSON.stringify(sealed.json().sealed)).not.toContain(alice.ticketId);

    // ...but the key is refused.
    const early = await post(`/v1/events/${EVENT.id}/manifest/key`, { scannerId: 'scn_early' });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('TOO_EARLY');

    // Two hours before doors, it is released.
    clock = DOORS - 2 * HOUR;
    const released = await post(`/v1/events/${EVENT.id}/manifest/key`, { scannerId: 'scn_early' });
    expect(released.statusCode).toBe(200);
    expect(released.json().key).toBeTypeOf('string');
  });

  it('names the fans with no template instead of silently dropping them', async () => {
    // Somebody who bought a ticket then withdrew biometric consent. They must
    // still get in — through the resolution desk — and the operator should know
    // in advance rather than one refused fan at a time.
    const alice = await fan(2);
    await post(`/v1/identities/${alice.identityId}/consents/biometric_enrolment/withdraw`);

    const keys = generateDeviceKey();
    await post('/v1/scanners', {
      scannerId: 'scn_missing',
      eventId: EVENT.id,
      lane: 'lane_1',
      publicKeyPem: keys.publicKeyPem,
    });
    clock = DOORS;
    const sealed = await post(`/v1/events/${EVENT.id}/manifest/sealed`, { scannerId: 'scn_missing' });

    expect(sealed.json().included).toBe(0);
    expect(sealed.json().missingTemplates).toContain(alice.identityId);
  });

  it('refuses to open a manifest issued to a different lane', async () => {
    await fan(3);
    clock = DOORS;
    const a = await lane('scn_a', 'lane_a');
    const b = await lane('scn_b', 'lane_b');

    const keyForB = (await post(`/v1/events/${EVENT.id}/manifest/key`, { scannerId: 'scn_b' })).json().key;
    // Lane B's key against lane A's manifest: different derivation, no open.
    expect(() => openManifest(a.sealed.sealed, Buffer.from(keyForB, 'base64'), clock)).toThrow();
    expect(b.engine.status(clock).credentials).toBe(1);
  });
});

describe('the exit criterion: a scanner with the network off decides correctly', () => {
  it('runs a whole gate with no further calls to anything', async () => {
    const alice = await fan(10);
    const bob = await fan(11);
    clock = DOORS;

    const { engine } = await lane('scn_offline', 'lane_1');
    engine.setOnline(false);

    // The manifest was opened before the network went away; from here, nothing.
    expect(engine.scan(capture(face(10), 0.2, 31), clock).decision).toMatchObject({
      outcome: 'admit',
      ticketId: alice.ticketId,
    });
    expect(engine.scan(capture(face(11), 0.2, 32), clock).decision).toMatchObject({
      outcome: 'admit',
      ticketId: bob.ticketId,
    });
    // A stranger.
    expect(engine.scan(capture(face(900), 0.2, 33), clock).decision.outcome).toBe('fallback');
    // Alice again.
    expect(engine.scan(capture(face(10), 0.2, 34), clock).decision.code).toBe('ALREADY_ADMITTED');

    const status = engine.status(clock);
    expect(status.online).toBe(false);
    expect(status.pendingUploads).toBe(4);
  });

  it('uploads its signed queue when the network returns, and the server verifies each one', async () => {
    await fan(12);
    clock = DOORS;
    const { engine } = await lane('scn_upload', 'lane_1');
    engine.setOnline(false);

    engine.scan(capture(face(12), 0.2, 41), clock);
    engine.scan(capture(face(901), 0.2, 42), clock + 1000);

    engine.setOnline(true);
    const pending = engine.pendingUploads();
    const uploaded = await post(`/v1/events/${EVENT.id}/attestations/signed`, { attestations: pending });

    expect(uploaded.statusCode).toBe(202);
    expect(uploaded.json()).toMatchObject({ received: 2, verified: 2, inserted: 2, rejected: [] });
    engine.acknowledgeUploads(2);
    expect(engine.status(clock).pendingUploads).toBe(0);
  });

  it('refuses an attestation whose record was edited after signing', async () => {
    await fan(13);
    clock = DOORS;
    const { engine } = await lane('scn_forge', 'lane_1');

    const denied = engine.scan(capture(face(902), 0.2, 51), clock).attestation;
    // Turning a fallback into an admission after the fact.
    const forged = { ...denied, outcome: 'admit' as const, code: 'MATCHED' as const };

    const r = await post(`/v1/events/${EVENT.id}/attestations/signed`, { attestations: [forged] });
    expect(r.json().verified).toBe(0);
    expect(r.json().rejected[0].reason).toBe('BAD_SIGNATURE');
  });

  it('refuses an attestation from a device nobody registered', async () => {
    await fan(14);
    clock = DOORS;
    const rogueKeys = generateDeviceKey();
    const rogue = new GateEngine(
      { eventId: EVENT.id, scannerId: 'scn_rogue', sequence: 0, generatedAt: clock, expiresAt: clock + HOUR, entries: [] },
      { scannerId: 'scn_rogue', lane: 'lane_x', gateGroup: 'north', privateKeyPem: rogueKeys.privateKeyPem, allowReentry: false },
    );
    const a = rogue.scan(capture(face(14), 0.2, 61), clock).attestation;

    const r = await post(`/v1/events/${EVENT.id}/attestations/signed`, { attestations: [a] });
    expect(r.json().rejected[0].reason).toBe('UNKNOWN_SCANNER');
    expect(r.json().inserted).toBe(0);
  });

  it('accepts a re-uploaded batch without double counting', async () => {
    await fan(15);
    clock = DOORS;
    const { engine } = await lane('scn_retry', 'lane_1');
    engine.scan(capture(face(15), 0.2, 71), clock);

    const batch = { attestations: engine.pendingUploads() };
    expect((await post(`/v1/events/${EVENT.id}/attestations/signed`, batch)).json().inserted).toBe(1);
    const replay = await post(`/v1/events/${EVENT.id}/attestations/signed`, batch);
    expect(replay.json()).toMatchObject({ verified: 1, inserted: 0, duplicates: 1 });
  });
});

describe('the exit criterion: a resale revokes the seller at every lane', () => {
  it('propagates to three lanes well inside thirty seconds', async () => {
    // Everyone buys before sales close, which is two hours before doors.
    const alice = await fan(20);
    const bob = await fan(21);
    const carol = await fan(22);
    clock = DOORS;

    const lanes = [await lane('scn_l1', 'lane_1'), await lane('scn_l2', 'lane_2'), await lane('scn_l3', 'lane_3')];

    // Every lane admits Alice right now.
    for (const l of lanes) {
      expect(l.engine.scan(capture(face(20), 0.2, 81), clock).decision.outcome).toBe('admit');
    }

    const listed = await post('/v1/listings', {
      ticketId: alice.ticketId,
      identityId: alice.identityId,
      priceMinor: 242_000,
    });
    expect(listed.statusCode).toBe(201);

    const soldAt = clock;
    const sold = await post(`/v1/listings/${listed.json().listingId}/buy`, {
      buyerIdentityId: carol.identityId,
      expectedPriceMinor: 242_000,
    });
    expect(sold.statusCode).toBe(201);

    // Each lane polls for deltas. Poll interval is five seconds; this simulates
    // the worst case of every lane having just missed a poll.
    clock = soldAt + 5_000;
    const deltas = (await get(`/v1/events/${EVENT.id}/deltas?since=${lanes[0]!.engine.status(clock).sequence}`)).json();
    for (const l of lanes) l.engine.applyDeltas(deltas.deltas);

    const propagationMs = clock - soldAt;
    expect(propagationMs).toBeLessThan(30_000);

    // Alice — who still has the same face — is now denied at every lane.
    for (const l of lanes) {
      const d = l.engine.scan(capture(face(20), 0.2, 82), clock).decision;
      expect(d, `lane ${l.scannerId} still admitted the seller`).toMatchObject({
        outcome: 'deny',
        code: 'CREDENTIAL_REVOKED',
      });
    }

    // And the ticket is Carol's on the server side.
    const carolTickets = (await get(`/v1/identities/${carol.identityId}/tickets`)).json().tickets;
    expect(carolTickets.some((t: { id: string }) => t.id === alice.ticketId)).toBe(true);
    expect(bob.ticketId).not.toBe(alice.ticketId);
  });

  it('a lane that missed the delta says it is behind rather than admitting quietly', async () => {
    const alice = await fan(23);
    const carol = await fan(24);
    clock = DOORS;
    const fresh = await lane('scn_fresh', 'lane_1');
    const stale = await lane('scn_stale', 'lane_2');

    await post('/v1/listings', { ticketId: alice.ticketId, identityId: alice.identityId, priceMinor: 242_000 });
    const listingId = (await get(`/v1/events/${EVENT.id}/listings`)).json().listings[0].id;
    await post(`/v1/listings/${listingId}/buy`, {
      buyerIdentityId: carol.identityId,
      expectedPriceMinor: 242_000,
    });

    const server = (await get(`/v1/events/${EVENT.id}/deltas?since=${fresh.engine.status(clock).sequence}`)).json();
    fresh.engine.applyDeltas(server.deltas);
    stale.engine.noteServerSequence(server.serverSequence);

    // The stale lane has NOT applied the revocation, so it would still admit —
    // and that is exactly why it must show the operator it is behind.
    const s = stale.engine.status(clock);
    expect(s.behindBy).toBeGreaterThan(0);
    expect(s.warn).toBe(true);
    expect(fresh.engine.status(clock).warn).toBe(false);
  });
});

describe('per-lane operations view', () => {
  it('reports fallback and offline rates per lane', async () => {
    await fan(30);
    clock = DOORS;
    const l1 = await lane('scn_ops1', 'lane_1');
    const l2 = await lane('scn_ops2', 'lane_2');

    l1.engine.setOnline(true);
    l1.engine.scan(capture(face(30), 0.2, 91), clock);
    l2.engine.setOnline(false);
    l2.engine.scan(capture(face(950), 0.2, 92), clock + 1000);

    await post(`/v1/events/${EVENT.id}/attestations/signed`, { attestations: l1.engine.pendingUploads() });
    await post(`/v1/events/${EVENT.id}/attestations/signed`, { attestations: l2.engine.pendingUploads() });

    const lanes = (await get(`/v1/events/${EVENT.id}/lanes`)).json().lanes;
    const one = lanes.find((l: { lane: string }) => l.lane === 'lane_1');
    const two = lanes.find((l: { lane: string }) => l.lane === 'lane_2');

    expect(one).toMatchObject({ admitted: 1, fallbackRate: 0, offlineRate: 0 });
    expect(two).toMatchObject({ fallback: 1, fallbackRate: 1, offlineRate: 1 });
  });
});

describe('manifest TTL', () => {
  it('stops opening after expiry and the engine erases what it holds', async () => {
    await fan(40);
    clock = DOORS;
    const { engine, sealed } = await lane('scn_ttl', 'lane_1');

    const expiresAt = sealed.expiresAt as number;
    expect(engine.status(expiresAt - 1).expired).toBe(false);
    expect(engine.status(expiresAt).expired).toBe(true);

    // At expiry the scanner falls back rather than deciding on stale data...
    expect(engine.scan(capture(face(40), 0.2, 95), expiresAt).decision.code).toBe('MANIFEST_EXPIRED');
    // ...and erases, reporting what it destroyed so deletion can be audited.
    const erased = engine.erase();
    expect(erased.erased).toBe(1);
    expect(engine.status(expiresAt).credentials).toBe(0);

    // The key is no longer releasable either.
    clock = expiresAt + MINUTE;
    const late = await post(`/v1/events/${EVENT.id}/manifest/key`, { scannerId: 'scn_ttl' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('EXPIRED');
  });
});
