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
 * Getting back in from a second device.
 *
 * A ReXell ID is created on a phone and lives there, so without this, losing
 * the phone loses the tickets. What this replaces was worse than nothing: the
 * fan app briefly accepted the raw identity id as proof of ownership, and that
 * id is not a secret — it travels in URL paths and appears in server logs.
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
});

const post = (url: string, body: unknown = {}) =>
  app.server.inject({ method: 'POST', url, payload: body as object });

/** Enrol somebody the way the fan app does, and hand back their code. */
async function enrolledFan(seed = 3): Promise<{ id: string; code: string }> {
  const id = (await post('/v1/identities', {})).json().identityId as string;
  await post(`/v1/identities/${id}/consents`, { purposes: ['biometric_enrolment'] });
  const challenge = (await post(`/v1/identities/${id}/enrolment/challenge`)).json();
  const res = await post(`/v1/identities/${id}/enrolment`, {
    scope: 'global',
    vector: [...capture(face(seed), 0.2)],
    liveness: {
      challengeId: challenge.id,
      nonce: challenge.nonce,
      passiveScore: 0.96,
      actionCompleted: true,
      frames: livenessFrames(challenge.kind, face(seed)),
    },
  });
  return { id, code: res.json().recoveryCode as string };
}

describe('a code arrives with enrolment', () => {
  it('is handed over exactly once, when there is finally something to recover', async () => {
    const { code } = await enrolledFan();
    expect(code).toMatch(/^RXL(-[0-9A-Z]{5}){4}$/);
  });

  it('is not returned by any other route', async () => {
    const { id } = await enrolledFan();
    const consents = await app.server.inject({ method: 'GET', url: `/v1/identities/${id}/consents` });
    expect(JSON.stringify(consents.json())).not.toMatch(/RXL-/);
  });

  it('differs per person', async () => {
    const a = await enrolledFan(1);
    const b = await enrolledFan(2);
    expect(a.code).not.toBe(b.code);
  });
});

describe('redeeming one', () => {
  it('returns the identity it belongs to', async () => {
    const { id, code } = await enrolledFan();
    const res = await post('/v1/identities/recover', { code });
    expect(res.statusCode).toBe(200);
    expect(res.json().identityId).toBe(id);
    expect(res.json().enrolled).toBe(true);
  });

  it('accepts the code however it was transcribed', async () => {
    const { id, code } = await enrolledFan();
    const res = await post('/v1/identities/recover', { code: `  ${code.toLowerCase().replace(/-/g, ' ')} ` });
    expect(res.statusCode).toBe(200);
    expect(res.json().identityId).toBe(id);
  });

  it('works exactly once', async () => {
    const { code } = await enrolledFan();
    expect((await post('/v1/identities/recover', { code })).statusCode).toBe(200);

    const second = await post('/v1/identities/recover', { code });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.code).toBe('RECOVERY_CODE_INVALID');
  });

  it('hands back a replacement, so recovering twice in a row is possible', async () => {
    const { id, code } = await enrolledFan();
    const next = (await post('/v1/identities/recover', { code })).json().recoveryCode as string;
    expect(next).not.toBe(code);

    const again = await post('/v1/identities/recover', { code: next });
    expect(again.statusCode).toBe(200);
    expect(again.json().identityId).toBe(id);
  });

  it('leaves only one live code, so a spent one cannot come back', async () => {
    const { code } = await enrolledFan();
    const next = (await post('/v1/identities/recover', { code })).json().recoveryCode as string;
    // The replacement works…
    expect((await post('/v1/identities/recover', { code: next })).statusCode).toBe(200);
    // …and the original is still dead.
    expect((await post('/v1/identities/recover', { code })).statusCode).toBe(404);
  });
});

describe('what it refuses', () => {
  it.each([
    ['a code that was never issued', 'RXL-2W3K9-8HT4M-QRZ57-PN6VX'],
    ['a malformed code', 'not-a-code'],
    ['an empty-ish code', '   -  -  '],
  ])('refuses %s', async (_label, code) => {
    const res = await post('/v1/identities/recover', { code });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('says the same thing for a wrong code and a spent one', async () => {
    const { code } = await enrolledFan();
    await post('/v1/identities/recover', { code });
    const spent = await post('/v1/identities/recover', { code });
    const never = await post('/v1/identities/recover', { code: 'RXL-2W3K9-8HT4M-QRZ57-PN6VX' });

    // Distinguishing them would tell a guesser that their string was once real.
    expect(spent.statusCode).toBe(never.statusCode);
    expect(spent.json().error.message).toBe(never.json().error.message);
  });

  it('requires a code at all', async () => {
    expect((await post('/v1/identities/recover', {})).statusCode).toBe(400);
  });
});

describe('the identity id is no longer a credential', () => {
  it('cannot be used to recover anything', async () => {
    const { id } = await enrolledFan();
    // The old stopgap. An identity id appears in URL paths and server logs, so
    // accepting it here would make every log line a set of credentials.
    const res = await post('/v1/identities/recover', { code: id });
    expect(res.statusCode).toBe(404);
  });
});

describe('throttling', () => {
  it('meters guessing hard, without touching ordinary reads', async () => {
    app.db.close();
    app = buildApp({
      now,
      vault: httpVaultClient(vaultUrl, VAULT_TOKEN),
      rateLimit: { overall: { ratePerSecond: 50, burst: 200 }, creates: { ratePerSecond: 1 / 3600, burst: 3 } },
    });
    await app.server.ready();

    const guess = () => post('/v1/identities/recover', { code: 'RXL-2W3K9-8HT4M-QRZ57-PN6VX' });
    expect((await guess()).statusCode).toBe(404);
    expect((await guess()).statusCode).toBe(404);
    expect((await guess()).statusCode).toBe(404);
    expect((await guess()).statusCode).toBe(429);

    // The public catalogue is unaffected — the strict bucket is per-route.
    expect((await app.server.inject({ method: 'GET', url: '/v1/discover' })).statusCode).toBe(200);
  });
});
