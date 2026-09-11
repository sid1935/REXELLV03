import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { epochMs } from '@rexell/domain';
import type { EpochMs } from '@rexell/domain';
import { buildVault } from '../../vault/src/app.js';
import type { VaultApp } from '../../vault/src/app.js';
import { capture, face, livenessFrames } from '../../vault/test/helpers.js';
import { buildApp } from '../src/app.js';
import type { App } from '../src/app.js';
import { httpVaultClient } from '../src/vault-client.js';

/**
 * API ↔ vault, over a real socket.
 *
 * The vault listens on an ephemeral port and the API reaches it with `fetch`.
 * Calling the store directly would be faster and would prove nothing: the point
 * of M2 is that the boundary exists, so the tests have to cross it the way
 * production does.
 */
const T0 = 1_780_000_000_000;
let clock = T0;
const now = (): EpochMs => epochMs(clock);

let vault: VaultApp;
let vaultUrl: string;
let app: App;

const VAULT_TOKEN = 'test-service-token';

beforeAll(async () => {
  vault = buildVault({
    masterKey: randomBytes(32),
    receiptKey: randomBytes(32),
    serviceToken: VAULT_TOKEN,
    now: () => clock,
  });
  await vault.server.listen({ port: 0, host: '127.0.0.1' });
  const address = vault.server.addresses()[0];
  vaultUrl = `http://127.0.0.1:${address?.port}`;
});

afterAll(async () => {
  await vault.server.close();
  vault.store.close();
});

beforeEach(async () => {
  clock = T0;
  app = buildApp({ now, vault: httpVaultClient(vaultUrl, VAULT_TOKEN) });
  await app.server.ready();
});

const post = (url: string, body: unknown = {}) =>
  app.server.inject({ method: 'POST', url, payload: body as object });
const get = (url: string) => app.server.inject({ method: 'GET', url });

async function newIdentity(): Promise<string> {
  return (await post('/v1/identities', {})).json().identityId as string;
}

async function consentTo(id: string, purpose = 'biometric_enrolment') {
  return post(`/v1/identities/${id}/consents`, { purposes: [purpose] });
}

/** The full flow a real client performs: challenge, capture, submit. */
async function enrolThroughApi(id: string, faceVector: ReturnType<typeof face>, jitter = 0.2) {
  const challenge = (await post(`/v1/identities/${id}/enrolment/challenge`)).json();
  return post(`/v1/identities/${id}/enrolment`, {
    scope: 'global',
    vector: [...capture(faceVector, jitter)],
    liveness: {
      challengeId: challenge.id,
      nonce: challenge.nonce,
      passiveScore: 0.96,
      actionCompleted: true,
      frames: livenessFrames(challenge.kind, faceVector),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('a new identity is not enrolled just because it asked to be', () => {
  it('ignores an `enrolled` flag from the client', async () => {
    const r = await post('/v1/identities', { enrolled: true });
    expect(r.json().enrolled).toBe(false);
  });

  it('cannot buy a ticket before enrolling', async () => {
    const id = await newIdentity();
    // No event needed — the identity check runs before inventory is touched.
    const r = await post('/v1/orders', { identityId: id, tierId: 'tier_missing', quantity: 1 });
    expect([403, 404]).toContain(r.statusCode);
  });
});

describe('consent gates enrolment', () => {
  it('refuses to enrol without consent, and never reaches the vault', async () => {
    const id = await newIdentity();
    const r = await enrolThroughApi(id, face(1));
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('CONSENT_REQUIRED');
    expect(vault.store.isEnrolled(id, 'global')).toBe(false);
  });

  it('enrols once consent is on file', async () => {
    const id = await newIdentity();
    expect((await consentTo(id)).statusCode).toBe(201);

    const r = await enrolThroughApi(id, face(1));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ enrolled: true, replaced: false });
    expect(r.json().templateRef).toMatch(/^tpl_/);
    expect(vault.store.isEnrolled(id, 'global')).toBe(true);
  });

  it('rejects a form that bundles biometric consent with terms of service', async () => {
    const id = await newIdentity();
    const r = await post(`/v1/identities/${id}/consents`, {
      purposes: ['terms_of_service', 'biometric_enrolment'],
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('CONSENT_BUNDLED');
  });

  it('reports consent state per purpose', async () => {
    const id = await newIdentity();
    await consentTo(id);
    const state = (await get(`/v1/identities/${id}/consents`)).json();

    const biometric = state.current.find((c: { purpose: string }) => c.purpose === 'biometric_enrolment');
    const marketing = state.current.find((c: { purpose: string }) => c.purpose === 'marketing');
    expect(biometric.state).toBe('granted');
    expect(marketing.state).toBe('required');
    expect(state.history).toHaveLength(1);
  });
});

describe('enrolment goes through the vault, not around it', () => {
  it('refuses a fabricated liveness proof', async () => {
    const id = await newIdentity();
    await consentTo(id);

    const r = await post(`/v1/identities/${id}/enrolment`, {
      scope: 'global',
      vector: [...capture(face(1))],
      liveness: { challengeId: 'chl_made_up', nonce: 'invented', passiveScore: 1, actionCompleted: true },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('LIVENESS_FAILED');
    expect(vault.store.isEnrolled(id, 'global')).toBe(false);
  });

  it('leaves the identity unenrolled when the vault refuses', async () => {
    const id = await newIdentity();
    await consentTo(id);
    await post(`/v1/identities/${id}/enrolment`, {
      scope: 'global',
      vector: [...capture(face(1))],
      liveness: { challengeId: 'nope', nonce: 'nope', passiveScore: 1, actionCompleted: true },
    });
    // The API must not have optimistically flipped the flag.
    const orders = await post('/v1/orders', { identityId: id, tierId: 'tier_missing', quantity: 1 });
    expect([403, 404]).toContain(orders.statusCode);
  });

  it('fails closed when the vault is unreachable', async () => {
    // A vault that is down must never fail open into "this person is enrolled".
    const isolated = buildApp({ now, vault: httpVaultClient('http://127.0.0.1:1', 'x') });
    await isolated.server.ready();
    const id = (await isolated.server.inject({ method: 'POST', url: '/v1/identities', payload: {} })).json()
      .identityId;
    await isolated.server.inject({
      method: 'POST',
      url: `/v1/identities/${id}/consents`,
      payload: { purposes: ['biometric_enrolment'] },
    });

    const r = await isolated.server.inject({
      method: 'POST',
      url: `/v1/identities/${id}/enrolment/challenge`,
      payload: {},
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('VAULT_UNAVAILABLE');

    await isolated.server.close();
    isolated.db.close();
  });

  it('answers 503 rather than pretending when no vault is configured at all', async () => {
    const noVault = buildApp({ now });
    await noVault.server.ready();
    const id = (await noVault.server.inject({ method: 'POST', url: '/v1/identities', payload: {} })).json().identityId;
    const r = await noVault.server.inject({
      method: 'POST',
      url: `/v1/identities/${id}/enrolment/challenge`,
      payload: {},
    });
    expect(r.statusCode).toBe(503);
    await noVault.server.close();
    noVault.db.close();
  });
});

describe('the exit criterion: the same face on two accounts raises a flag', () => {
  it('flags across the API boundary without blocking either account', async () => {
    const scalper = face(101);

    const first = await newIdentity();
    await consentTo(first);
    const a = await enrolThroughApi(first, scalper, 0.15);
    expect(a.json().dedupe.status).toBe('clear');

    const second = await newIdentity();
    await consentTo(second);
    const b = await enrolThroughApi(second, scalper, 0.18);

    expect(b.statusCode).toBe(201);
    expect(b.json().dedupe.status).toBe('review');
    expect(b.json().dedupe.matches[0].identityId).toBe(first);
    // Both are enrolled. The flag is a review queue, not a gate.
    expect(vault.store.isEnrolled(first, 'global')).toBe(true);
    expect(vault.store.isEnrolled(second, 'global')).toBe(true);
  });
});

describe('the exit criterion: withdrawal deletes the template and returns a receipt', () => {
  it('destroys the template, unenrols, and hands back a verifiable receipt', async () => {
    const id = await newIdentity();
    await consentTo(id);
    await enrolThroughApi(id, face(7));
    expect(vault.store.isEnrolled(id, 'global')).toBe(true);

    clock = T0 + 86_400_000;
    const r = await post(`/v1/identities/${id}/consents/biometric_enrolment/withdraw`);

    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ withdrawn: true, enrolled: false });

    const receipt = r.json().receipt;
    expect(receipt).toMatchObject({ identityId: id, deletedCount: 1, reason: 'consent_withdrawn' });
    // Verified with the vault's own key — evidence, not an assertion.
    expect(vault.store.verifyReceipt(receipt)).toBe(true);
    expect(vault.store.verifyReceipt({ ...receipt, deletedCount: 99 })).toBe(false);

    // The template is gone and the identity is no longer enrolled.
    expect(vault.store.isEnrolled(id, 'global')).toBe(false);
    const consents = (await get(`/v1/identities/${id}/consents`)).json();
    const biometric = consents.current.find((c: { purpose: string }) => c.purpose === 'biometric_enrolment');
    expect(biometric.state).toBe('withdrawn');
  });

  it('keeps the grant in history — the ledger is append-only', async () => {
    const id = await newIdentity();
    await consentTo(id);
    await enrolThroughApi(id, face(8));
    await post(`/v1/identities/${id}/consents/biometric_enrolment/withdraw`);

    const history = (await get(`/v1/identities/${id}/consents`)).json().history;
    expect(history).toHaveLength(2);
    expect(history[0].grantedAt).not.toBeNull();
    expect(history[1].withdrawnAt).not.toBeNull();
    // What they agreed to, and when, survives the withdrawal.
    expect(history[0].textVersion).toBe(history[1].textVersion);
  });

  it('refuses to withdraw twice', async () => {
    const id = await newIdentity();
    await consentTo(id);
    await enrolThroughApi(id, face(9));
    expect((await post(`/v1/identities/${id}/consents/biometric_enrolment/withdraw`)).statusCode).toBe(200);

    const again = await post(`/v1/identities/${id}/consents/biometric_enrolment/withdraw`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('NOTHING_TO_WITHDRAW');
  });

  it('will not re-enrol on withdrawn consent — they said no', async () => {
    const id = await newIdentity();
    await consentTo(id);
    await enrolThroughApi(id, face(10));
    await post(`/v1/identities/${id}/consents/biometric_enrolment/withdraw`);

    const retry = await enrolThroughApi(id, face(10));
    expect(retry.statusCode).toBe(403);
    expect(retry.json().error.code).toBe('CONSENT_WITHDRAWN');
  });

  it('lets somebody change their mind and enrol again', async () => {
    const id = await newIdentity();
    await consentTo(id);
    await enrolThroughApi(id, face(11));
    await post(`/v1/identities/${id}/consents/biometric_enrolment/withdraw`);

    clock = T0 + 200_000;
    expect((await consentTo(id)).statusCode).toBe(201);
    const again = await enrolThroughApi(id, face(11));
    expect(again.statusCode).toBe(201);
    expect(vault.store.isEnrolled(id, 'global')).toBe(true);
  });
});

describe('the API never sees a template', () => {
  it('has no vault-client method capable of fetching a readable one', () => {
    const client = httpVaultClient(vaultUrl, VAULT_TOKEN) as unknown as Record<string, unknown>;

    // This list is a decision, not a snapshot. Adding a method here means adding
    // a way for the application plane to talk to the vault, and that should cost
    // somebody a moment's thought and a failing test.
    //
    // `sealManifest` is the one call that causes template material to leave the
    // vault at all (M4). What it returns is ciphertext bound to one device, one
    // event and one expiry — never a readable vector — and the assertion below
    // holds it to that.
    expect(Object.keys(client).sort()).toEqual([
      'challenge',
      'enrol',
      'forget',
      'identify',
      'releaseManifestKey',
      'sealManifest',
      'verify',
    ]);
    for (const forbidden of ['getTemplate', 'read', 'export', 'download', 'template']) {
      expect(client[forbidden]).toBeUndefined();
    }
  });

  it('gets ciphertext, not vectors, from the one call that moves template material', async () => {
    const id = await newIdentity();
    await consentTo(id);
    await enrolThroughApi(id, face(77));

    const client = httpVaultClient(vaultUrl, VAULT_TOKEN);
    const result = await client.sealManifest({
      scannerId: 'scn_boundary',
      eventId: 'evt_boundary',
      scope: 'global',
      sequence: 0,
      expiresAt: T0 + 86_400_000,
      releaseFrom: T0,
      credentials: [
        {
          ticketId: 'tkt_boundary',
          identityId: id,
          tierId: 'tier_ga',
          gates: [],
          admitFrom: T0,
          admitUntil: T0 + 86_400_000,
          revoked: false,
        },
      ],
    });

    expect(result.included).toBe(1);
    const body = JSON.stringify(result);
    // No bare numeric arrays, and no plaintext identity in the sealed envelope.
    expect(body.match(/\[[-0-9.eE,\s]{200,}\]/g) ?? []).toEqual([]);
    expect(result.sealed.ciphertext).not.toContain(id);
    expect(JSON.stringify(result.sealed)).not.toContain('tkt_boundary');
  });

  it('stores no template material in the application database', async () => {
    const id = await newIdentity();
    await consentTo(id);
    await enrolThroughApi(id, face(12));

    // Sweep every table the application owns for anything vector-shaped.
    const tables = app.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((t) => t.name);

    for (const table of tables) {
      const rows = app.db.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
      const dump = JSON.stringify(rows);
      expect(dump, `table ${table} looks like it holds vector data`).not.toMatch(
        /\[[-0-9.eE,\s]{200,}\]/,
      );
      expect(Object.keys(rows[0] ?? {})).not.toContain('ciphertext');
    }
  });
});

/**
 * Signing in by being recognised.
 *
 * The route takes no identity at all — it searches every enrolled template and
 * returns one account or none. These tests are mostly about what it must NOT
 * say: a near miss and a total stranger have to be indistinguishable from the
 * outside, because a caller who can tell them apart can walk uphill towards
 * somebody else's face without ever seeing it.
 */
describe('face sign-in', () => {
  it('finds the right account from the face alone', async () => {
    const alice = await newIdentity();
    const bob = await newIdentity();
    await consentTo(alice);
    await consentTo(bob);
    await enrolThroughApi(alice, face(41));
    await enrolThroughApi(bob, face(42));

    // A second capture of Alice: a different vector, never an equal one.
    const probe = [...capture(face(41), 0.2)];
    const res = await post('/v1/identities/identify', { vector: probe });

    expect(res.statusCode).toBe(200);
    expect(res.json().identityId).toBe(alice);
    expect(res.json().enrolled).toBe(true);
    expect(res.json().score).toBeGreaterThan(0.5);
  });

  it('refuses a stranger, and says nothing about who they were close to', async () => {
    const alice = await newIdentity();
    await consentTo(alice);
    await enrolThroughApi(alice, face(41));

    const res = await post('/v1/identities/identify', { vector: [...face(999)] });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NO_MATCH');
    // No identity, no score, no "close to" — the body must not leak the
    // gallery's shape to somebody probing it.
    expect(JSON.stringify(res.json())).not.toContain('idn_');
    expect(res.json()).not.toHaveProperty('score');
  });

  it('gives an uncertain match the same answer as no match at all', async () => {
    const alice = await newIdentity();
    await consentTo(alice);
    await enrolThroughApi(alice, face(41));

    // Degraded enough to land below the match threshold. At a gate this would
    // be the review band and a human; here there is no human, so it is a
    // refusal — and one that reads exactly like a stranger's.
    const res = await post('/v1/identities/identify', { vector: [...capture(face(41), 2.5)] });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NO_MATCH');
    expect(JSON.stringify(res.json())).not.toContain(alice);
  });

  it('rejects a request with no vector', async () => {
    const res = await post('/v1/identities/identify', {});
    expect(res.statusCode).toBe(400);
  });
});

/**
 * Liveness, through the whole stack.
 *
 * The evidence rules themselves are covered in `packages/biometrics`; this is
 * about the seam. The challenge is issued by the vault through the API, the
 * capture comes back through the API, and the verdict is reached in the vault
 * — so a client that satisfies the browser but not the server has to fail
 * here, not in a unit test of a function nobody calls in production.
 */
describe('liveness at enrolment', () => {
  async function challengeFor(id: string) {
    return (await post(`/v1/identities/${id}/enrolment/challenge`)).json();
  }

  it('refuses an enrolment with no capture behind it', async () => {
    const id = await newIdentity();
    await consentTo(id);
    const challenge = await challengeFor(id);

    // Exactly what the old client sent: a vector and two booleans.
    const res = await post(`/v1/identities/${id}/enrolment`, {
      scope: 'global',
      vector: [...capture(face(31))],
      liveness: { challengeId: challenge.id, nonce: challenge.nonce, passiveScore: 0.96, actionCompleted: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/NO_EVIDENCE/);
  });

  it('refuses a photograph held up to the camera', async () => {
    const id = await newIdentity();
    await consentTo(id);
    const challenge = await challengeFor(id);
    const theirFace = face(32);

    // Twelve frames of a real face that never moves, which is what a camera
    // pointed at a print produces.
    const still = livenessFrames(challenge.kind, theirFace).map((f) => ({
      ...f,
      yaw: 0,
      pitch: 0,
      eyeOpen: 0.3,
    }));

    const res = await post(`/v1/identities/${id}/enrolment`, {
      scope: 'global',
      vector: [...capture(theirFace)],
      liveness: {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        passiveScore: 0.96,
        actionCompleted: true,
        frames: still,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/MOVEMENT_NOT_OBSERVED/);
  });

  it('refuses a capture that performs the wrong movement', async () => {
    const id = await newIdentity();
    await consentTo(id);
    const challenge = await challengeFor(id);
    const theirFace = face(33);

    // A recording made before the challenge was issued can only contain one
    // movement, and there is a three-in-four chance it is not this one.
    const other = (['turn_left', 'turn_right', 'nod', 'blink'] as const).find((k) => k !== challenge.kind)!;

    const res = await post(`/v1/identities/${id}/enrolment`, {
      scope: 'global',
      vector: [...capture(theirFace)],
      liveness: {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        passiveScore: 0.96,
        actionCompleted: true,
        frames: livenessFrames(other, theirFace),
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/MOVEMENT_NOT_OBSERVED/);
  });

  it('accepts somebody who actually performed it, and enrols them', async () => {
    const id = await newIdentity();
    await consentTo(id);
    const challenge = await challengeFor(id);
    const theirFace = face(34);

    const res = await post(`/v1/identities/${id}/enrolment`, {
      scope: 'global',
      vector: [...capture(theirFace)],
      liveness: {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        passiveScore: 0.96,
        actionCompleted: true,
        frames: livenessFrames(challenge.kind, theirFace),
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().enrolled).toBe(true);
  });

  it('does not let a successful capture be submitted twice', async () => {
    const id = await newIdentity();
    const second = await newIdentity();
    await consentTo(id);
    await consentTo(second);
    const challenge = await challengeFor(id);
    const theirFace = face(35);
    const proof = {
      challengeId: challenge.id,
      nonce: challenge.nonce,
      passiveScore: 0.96,
      actionCompleted: true,
      frames: livenessFrames(challenge.kind, theirFace),
    };

    expect((await post(`/v1/identities/${id}/enrolment`, { scope: 'global', vector: [...capture(theirFace)], liveness: proof })).statusCode).toBe(201);

    // The same proof, replayed onto a different account. The nonce is spent,
    // so the evidence — however genuine it was a second ago — buys nothing.
    const replay = await post(`/v1/identities/${second}/enrolment`, {
      scope: 'global',
      vector: [...capture(theirFace)],
      liveness: proof,
    });
    expect(replay.statusCode).toBe(403);
    expect(replay.json().error.message).toMatch(/CHALLENGE_UNKNOWN/);
  });
});
