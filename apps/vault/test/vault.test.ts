import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOTYPE_THRESHOLDS, similarity } from '@rexell/biometrics';
import { buildVault } from '../src/app.js';
import type { VaultApp } from '../src/app.js';
import { capture, enrol, face, livenessFrames } from './helpers.js';

let vault: VaultApp;
let clock = 1_000_000;
const MASTER = randomBytes(32);
const RECEIPT = randomBytes(32);

const post = (url: string, payload: unknown) =>
  vault.server.inject({ method: 'POST', url, payload: payload as object });
const get = (url: string) => vault.server.inject({ method: 'GET', url });

beforeEach(async () => {
  clock = 1_000_000;
  vault = buildVault({ masterKey: MASTER, receiptKey: RECEIPT, now: () => clock });
  await vault.server.ready();
});

afterEach(async () => {
  await vault.server.close();
  vault.store.close();
});

describe('enrolment', () => {
  it('enrols behind a liveness challenge and hands back a reference', async () => {
    const r = await enrol(vault, 'idn_alice', 'evt_1', face(1));
    expect(r.statusCode).toBe(201);
    expect(r.json().templateRef).toMatch(/^tpl_/);
    expect(r.json().dedupe.status).toBe('clear');
  });

  it('refuses a template with no challenge at all — the replay attack', async () => {
    // Without the challenge handshake, enrolment is just a POST that accepts a
    // vector, and the camera is optional for an attacker.
    const r = await post('/v1/enrol', {
      identityId: 'idn_mallory',
      scope: 'evt_1',
      consentId: 'con_x',
      vector: [...capture(face(9))],
      liveness: { challengeId: 'chl_invented', nonce: 'made-up', passiveScore: 1, actionCompleted: true },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('LIVENESS_FAILED');
  });

  it('burns a challenge on a failed attempt, so it cannot be retried', async () => {
    const challenge = (await post('/v1/challenges', {})).json();
    const body = (nonce: string) => ({
      identityId: 'idn_mallory',
      scope: 'evt_1',
      consentId: 'con_x',
      vector: [...capture(face(9))],
      liveness: { challengeId: challenge.id, nonce, passiveScore: 0.99, actionCompleted: true },
    });

    // Wrong nonce first.
    expect((await post('/v1/enrol', body('wrong'))).statusCode).toBe(403);
    // Now the right nonce — but the challenge is already consumed.
    const second = await post('/v1/enrol', body(challenge.nonce));
    expect(second.statusCode).toBe(403);
    expect(second.json().error.message).toMatch(/CHALLENGE_UNKNOWN/);
  });

  it('refuses an expired challenge', async () => {
    const challenge = (await post('/v1/challenges', {})).json();
    clock = challenge.expiresAt;
    const r = await post('/v1/enrol', {
      identityId: 'idn_alice',
      scope: 'evt_1',
      consentId: 'con_x',
      vector: [...capture(face(1))],
      liveness: { challengeId: challenge.id, nonce: challenge.nonce, passiveScore: 0.99, actionCompleted: true },
    });
    expect(r.json().error.message).toMatch(/CHALLENGE_EXPIRED/);
  });

  it('refuses when the action was not performed or passive liveness is weak', async () => {
    for (const bad of [{ actionCompleted: false, passiveScore: 0.99 }, { actionCompleted: true, passiveScore: 0.2 }]) {
      const challenge = (await post('/v1/challenges', {})).json();
      const r = await post('/v1/enrol', {
        identityId: 'idn_alice',
        scope: 'evt_1',
        consentId: 'con_x',
        vector: [...capture(face(1))],
        liveness: { challengeId: challenge.id, nonce: challenge.nonce, ...bad },
      });
      expect(r.statusCode).toBe(403);
    }
  });

  it('replaces rather than duplicates on re-enrolment', async () => {
    const first = await enrol(vault, 'idn_alice', 'evt_1', face(1));
    const second = await enrol(vault, 'idn_alice', 'evt_1', face(1), { jitter: 0.3 });
    expect(second.json().replaced).toBe(true);
    expect(second.json().templateRef).toBe(first.json().templateRef);
  });

  it('refuses a template from a model it cannot compare against', async () => {
    const challenge = (await post('/v1/challenges', {})).json();
    const r = await post('/v1/enrol', {
      identityId: 'idn_alice',
      scope: 'evt_1',
      consentId: 'con_x',
      modelVersion: 'someone-elses-model-v2',
      vector: [...capture(face(1))],
      // Real evidence, because liveness is checked before the model version —
      // deliberately, so an unproven capture is refused before any work is done
      // on it. Without this the test would pass on the wrong 403.
      liveness: {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        passiveScore: 0.99,
        actionCompleted: true,
        frames: livenessFrames(challenge.kind, face(1)),
      },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('MODEL_VERSION_MISMATCH');
  });
});

describe('the exit criterion: the same face on two accounts raises a flag', () => {
  it('flags, and does not block', async () => {
    const scalper = face(42);

    const first = await enrol(vault, 'idn_account_1', 'onsale', scalper, { jitter: 0.15 });
    expect(first.json().dedupe.status).toBe('clear');

    const second = await enrol(vault, 'idn_account_2', 'onsale', scalper, { jitter: 0.18 });
    // Flagged...
    expect(second.json().dedupe.status).toBe('review');
    expect(second.json().dedupe.matches[0].identityId).toBe('idn_account_1');
    expect(second.json().dedupe.matches[0].score).toBeGreaterThanOrEqual(PROTOTYPE_THRESHOLDS.dedupe);
    // ...but enrolled anyway. Twins and siblings exist; a biometric that cannot
    // be appealed is a liability, so this is a review queue, not a gate.
    expect(second.statusCode).toBe(201);
    expect(second.json().templateRef).toMatch(/^tpl_/);
  });

  it('surfaces open flags for review and lets an operator resolve them', async () => {
    const twin = face(43);
    await enrol(vault, 'idn_a', 'onsale', twin, { jitter: 0.15 });
    await enrol(vault, 'idn_b', 'onsale', twin, { jitter: 0.17 });

    const flags = (await get('/v1/scopes/onsale/flags')).json().flags;
    expect(flags).toHaveLength(1);

    const resolved = await post(`/v1/flags/${flags[0].flag_id}/resolve`, { resolution: 'different_people' });
    expect(resolved.statusCode).toBe(200);
    expect((await get('/v1/scopes/onsale/flags')).json().flags).toHaveLength(0);

    // Resolving twice is a conflict, not a silent no-op.
    expect((await post(`/v1/flags/${flags[0].flag_id}/resolve`, { resolution: 'same_person' })).statusCode).toBe(409);
  });

  it('does not flag two different people', async () => {
    await enrol(vault, 'idn_a', 'onsale', face(1));
    const second = await enrol(vault, 'idn_b', 'onsale', face(2));
    expect(second.json().dedupe.status).toBe('clear');
  });

  it('scopes the gallery — the same face in two events is not a duplicate', async () => {
    const person = face(5);
    await enrol(vault, 'idn_a', 'evt_1', person, { jitter: 0.15 });
    const other = await enrol(vault, 'idn_b', 'evt_2', person, { jitter: 0.15 });
    expect(other.json().dedupe.status).toBe('clear');
  });
});

describe('matching', () => {
  it('verifies the enrolled person and rejects a stranger', async () => {
    const alice = face(1);
    await enrol(vault, 'idn_alice', 'evt_1', alice, { jitter: 0.15 });

    const her = await post('/v1/verify', { identityId: 'idn_alice', scope: 'evt_1', probe: [...capture(alice, 0.2, 99)] });
    expect(her.json().matched).toBe(true);

    const stranger = await post('/v1/verify', { identityId: 'idn_alice', scope: 'evt_1', probe: [...capture(face(77))] });
    expect(stranger.json().matched).toBe(false);
  });

  it('identifies 1:N within a scope', async () => {
    const alice = face(1);
    await enrol(vault, 'idn_alice', 'evt_1', alice, { jitter: 0.15 });
    await enrol(vault, 'idn_bob', 'evt_1', face(2), { jitter: 0.15 });
    await enrol(vault, 'idn_carol', 'evt_1', face(3), { jitter: 0.15 });

    const found = await post('/v1/identify', { scope: 'evt_1', probe: [...capture(alice, 0.2, 55)] });
    expect(found.json()).toMatchObject({ matched: true, identityId: 'idn_alice' });
  });

  it('returns no identity when nothing clears the threshold', async () => {
    await enrol(vault, 'idn_alice', 'evt_1', face(1));
    const r = await post('/v1/identify', { scope: 'evt_1', probe: [...capture(face(500))] });
    expect(r.json().matched).toBe(false);
    expect(r.json().identityId).toBeUndefined();
  });

  it('reports not-enrolled as a clean no-match rather than an error', async () => {
    const r = await post('/v1/verify', { identityId: 'idn_nobody', scope: 'evt_1', probe: [...capture(face(1))] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ matched: false, score: 0 });
  });

  it('never claims two captures of one face are identical', async () => {
    // The property the whole architecture rests on. If this ever became 1.0,
    // somebody could hash a face and compare hashes.
    const alice = face(1);
    const a = capture(alice, 0.2, 1);
    const b = capture(alice, 0.2, 2);
    const score = similarity(a, b);
    expect(score).toBeLessThan(1);
    expect(score).toBeGreaterThan(PROTOTYPE_THRESHOLDS.review);
  });
});

describe('the exit criterion: deletion returns a verifiable receipt', () => {
  it('deletes the template and signs the receipt', async () => {
    await enrol(vault, 'idn_alice', 'evt_1', face(1));
    expect(vault.store.isEnrolled('idn_alice', 'evt_1')).toBe(true);

    const receipt = (await post('/v1/forget', { identityId: 'idn_alice', reason: 'consent_withdrawn' })).json();

    expect(receipt).toMatchObject({ identityId: 'idn_alice', deletedCount: 1, reason: 'consent_withdrawn' });
    expect(receipt.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(vault.store.verifyReceipt(receipt)).toBe(true);

    // Gone, and matching now fails.
    expect(vault.store.isEnrolled('idn_alice', 'evt_1')).toBe(false);
    const after = await post('/v1/verify', { identityId: 'idn_alice', scope: 'evt_1', probe: [...capture(face(1))] });
    expect(after.json().matched).toBe(false);
  });

  it('rejects a receipt whose fields have been altered', async () => {
    await enrol(vault, 'idn_alice', 'evt_1', face(1));
    const receipt = (await post('/v1/forget', { identityId: 'idn_alice' })).json();

    expect(vault.store.verifyReceipt({ ...receipt, deletedCount: 0 })).toBe(false);
    expect(vault.store.verifyReceipt({ ...receipt, identityId: 'idn_someone_else' })).toBe(false);
    expect(vault.store.verifyReceipt({ ...receipt, deletedAt: receipt.deletedAt + 1 })).toBe(false);
  });

  it('deletes across every scope, not just one', async () => {
    await enrol(vault, 'idn_alice', 'evt_1', face(1));
    await enrol(vault, 'idn_alice', 'evt_2', face(1));
    const receipt = (await post('/v1/forget', { identityId: 'idn_alice' })).json();
    expect(receipt.deletedCount).toBe(2);
  });

  it('issues an honest receipt when there was nothing to delete', async () => {
    const receipt = (await post('/v1/forget', { identityId: 'idn_ghost' })).json();
    expect(receipt.deletedCount).toBe(0);
    expect(vault.store.verifyReceipt(receipt)).toBe(true);
  });

  it('clears dedupe flags naming the deleted identity', async () => {
    const twin = face(60);
    await enrol(vault, 'idn_a', 'onsale', twin, { jitter: 0.15 });
    await enrol(vault, 'idn_b', 'onsale', twin, { jitter: 0.16 });
    expect((await get('/v1/scopes/onsale/flags')).json().flags).toHaveLength(1);

    // Deleting the *matched* identity must not leave a flag pointing at a
    // pseudonym whose biometric no longer exists.
    await post('/v1/forget', { identityId: 'idn_a' });
    expect((await get('/v1/scopes/onsale/flags')).json().flags).toHaveLength(0);
  });
});

describe('audit', () => {
  it('logs every operation that touched a template', async () => {
    await enrol(vault, 'idn_alice', 'evt_1', face(1));
    await post('/v1/verify', { identityId: 'idn_alice', scope: 'evt_1', probe: [...capture(face(1))] });
    await post('/v1/forget', { identityId: 'idn_alice' });

    const log = vault.store.accessLog();
    expect(log.map((e) => e.operation)).toEqual(['enrol', 'verify', 'forget']);
    expect(log.every((e) => e.at === clock)).toBe(true);
  });
});

describe('the service is not reachable without credentials', () => {
  it('rejects an unauthenticated call when a token is configured', async () => {
    const locked = buildVault({ masterKey: MASTER, receiptKey: RECEIPT, serviceToken: 'secret' });
    await locked.server.ready();

    const anon = await locked.server.inject({ method: 'POST', url: '/v1/challenges', payload: {} });
    expect(anon.statusCode).toBe(401);

    const authed = await locked.server.inject({
      method: 'POST',
      url: '/v1/challenges',
      payload: {},
      headers: { 'x-vault-token': 'secret' },
    });
    expect(authed.statusCode).toBe(201);

    // Health stays open so a load balancer can reach it.
    expect((await locked.server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);

    await locked.server.close();
    locked.store.close();
  });
});
