import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { epochMs } from '@rexell/domain';
import type { EpochMs } from '@rexell/domain';
import { buildApp } from '../src/app.js';
import type { App } from '../src/app.js';
import { TokenBucket } from '../src/rate-limit.js';
import { ConfigError, loadConfig } from '../src/config.js';

/**
 * The things that stood between this and being deployable.
 *
 * Every case here corresponds to something that was actually true of the
 * running server: signup handed a live API key to anybody who asked, 200
 * requests in a row drew 200 successes, and a production process with no
 * configuration started happily in the weakest posture available.
 */

const T0 = 1_780_000_000_000;

let app: App;
let clock = T0;
const now = (): EpochMs => epochMs(clock);

afterEach(() => {
  // Only the suites that build one. The config suite does not touch a database,
  // and closing a handle twice throws.
  app?.db.close();
  app = undefined as unknown as App;
});

const signup = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.server.inject({
    method: 'POST',
    url: '/v1/organizers',
    payload: body,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('the token bucket', () => {
  it('permits a burst and then meters', () => {
    const bucket = new TokenBucket({ ratePerSecond: 1, burst: 3 });
    expect(bucket.take('a', T0).ok).toBe(true);
    expect(bucket.take('a', T0).ok).toBe(true);
    expect(bucket.take('a', T0).ok).toBe(true);
    expect(bucket.take('a', T0).ok).toBe(false);
  });

  it('tells a refused caller when to come back, rather than just refusing', () => {
    const bucket = new TokenBucket({ ratePerSecond: 2, burst: 1 });
    bucket.take('a', T0);
    const refused = bucket.take('a', T0);
    expect(refused.ok).toBe(false);
    // One token at two per second is half a second.
    expect(refused.retryAfterMs).toBe(500);
  });

  it('refills continuously, so there is no window boundary to game', () => {
    const bucket = new TokenBucket({ ratePerSecond: 10, burst: 10 });
    for (let i = 0; i < 10; i += 1) bucket.take('a', T0);
    expect(bucket.take('a', T0).ok).toBe(false);
    expect(bucket.take('a', T0 + 100).ok).toBe(true);
  });

  it('keys callers separately', () => {
    const bucket = new TokenBucket({ ratePerSecond: 1, burst: 1 });
    expect(bucket.take('a', T0).ok).toBe(true);
    expect(bucket.take('a', T0).ok).toBe(false);
    expect(bucket.take('b', T0).ok).toBe(true);
  });

  it('cannot be made to mint tokens by a clock that goes backwards', () => {
    const bucket = new TokenBucket({ ratePerSecond: 1, burst: 2 });
    bucket.take('a', T0);
    bucket.take('a', T0);
    expect(bucket.take('a', T0 - 60_000).ok).toBe(false);
  });

  it('forgets buckets that have refilled, so the map is not a leak', () => {
    const bucket = new TokenBucket({ ratePerSecond: 1, burst: 2 });
    bucket.take('a', T0);
    expect(bucket.size).toBe(1);
    bucket.sweep(T0 + 1_000);
    expect(bucket.size).toBe(1); // not full yet
    bucket.sweep(T0 + 10_000);
    expect(bucket.size).toBe(0);
  });
});

describe('rate limiting, over HTTP', () => {
  beforeEach(() => {
    clock = T0;
    app = buildApp({
      now,
      rateLimit: {
        overall: { ratePerSecond: 1, burst: 3 },
        creates: { ratePerSecond: 1 / 3600, burst: 1 },
      },
    });
  });

  it('answers 429 with a retry-after once the burst is spent', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await app.server.inject({ method: 'GET', url: '/v1/discover' })).statusCode).toBe(200);
    }
    const refused = await app.server.inject({ method: 'GET', url: '/v1/discover' });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never throttles the health check, because a throttled probe reads as an outage', async () => {
    for (let i = 0; i < 50; i += 1) {
      expect((await app.server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
  });

  it('meters organizer signup far harder than reads', async () => {
    const first = await signup({ name: 'One' });
    expect(first.statusCode).toBe(201);

    // Second signup from the same caller, immediately. The overall bucket still
    // has room; the creates bucket does not.
    const second = await signup({ name: 'Two' });
    expect(second.statusCode).toBe(429);
  });

  it('lets the queue drain over time rather than locking a caller out', async () => {
    for (let i = 0; i < 4; i += 1) await app.server.inject({ method: 'GET', url: '/v1/discover' });
    clock = T0 + 5_000;
    expect((await app.server.inject({ method: 'GET', url: '/v1/discover' })).statusCode).toBe(200);
  });
});

describe('signup, when the deployment is invite-only', () => {
  beforeEach(() => {
    clock = T0;
    app = buildApp({ now, signup: { mode: 'invite', token: 'a-token-of-at-least-24-chars' } });
  });

  it('refuses an organizer signup with no token', async () => {
    const res = await signup({ name: 'Uninvited Promotions' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SIGNUP_CLOSED');
  });

  it('refuses a wrong token', async () => {
    const res = await signup({ name: 'Uninvited' }, { 'x-signup-token': 'b-token-of-at-least-24-chars' });
    expect(res.statusCode).toBe(403);
  });

  it('admits the right one', async () => {
    const res = await signup({ name: 'Invited Promotions' }, { 'x-signup-token': 'a-token-of-at-least-24-chars' });
    expect(res.statusCode).toBe(201);
    expect(res.json().apiKey).toMatch(/^rxl_live_/);
  });

  it('closes the other unauthenticated write too, not just signup', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { event: {} },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SIGNUP_CLOSED');
  });

  it('leaves the public catalogue alone', async () => {
    expect((await app.server.inject({ method: 'GET', url: '/v1/discover' })).statusCode).toBe(200);
  });
});

describe('signup, when the deployment is open', () => {
  beforeEach(() => {
    clock = T0;
    app = buildApp({ now, signup: { mode: 'open' } });
  });

  it('is still the M6 self-serve flow', async () => {
    const res = await signup({ name: 'Southside Venues' });
    expect(res.statusCode).toBe(201);
  });
});

describe('security headers', () => {
  beforeEach(() => {
    clock = T0;
    app = buildApp({ now });
  });

  it('sends the set that costs nothing', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/v1/discover' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('does not claim HSTS, because this process does not know whether TLS is real', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/v1/discover' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('configuration', () => {
  const base = { REXELL_ENV: 'production', VAULT_TOKEN: 'vt', ONSALE_SECRET: Buffer.alloc(32).toString('base64') };

  it('refuses to start a production process with nothing configured', () => {
    expect(() => loadConfig({ REXELL_ENV: 'production' })).toThrow(ConfigError);
  });

  it('names every problem at once, rather than one per restart', () => {
    try {
      loadConfig({ REXELL_ENV: 'production' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const problems = (e as ConfigError).problems;
      expect(problems.length).toBeGreaterThanOrEqual(3);
      expect(problems.join('\n')).toMatch(/SIGNUP_INVITE_TOKEN/);
      expect(problems.join('\n')).toMatch(/ONSALE_SECRET/);
      expect(problems.join('\n')).toMatch(/VAULT_TOKEN/);
    }
  });

  it('lets production be genuinely open, if that is said out loud', () => {
    const config = loadConfig({ ...base, SIGNUP_OPEN: 'true' });
    expect(config.signup.mode).toBe('open');
  });

  it('defaults development to open signup, because that is the demo', () => {
    expect(loadConfig({}).signup.mode).toBe('open');
  });

  it('rejects a short invite token', () => {
    expect(() => loadConfig({ ...base, SIGNUP_INVITE_TOKEN: 'short' })).toThrow(ConfigError);
  });

  it('rejects a secret that decodes to fewer than 32 bytes', () => {
    // The trap: Buffer.from does not throw on garbage, it returns something short.
    expect(() => loadConfig({ ...base, SIGNUP_OPEN: 'true', ONSALE_SECRET: 'aGk=' })).toThrow(ConfigError);
  });

  it('refuses plaintext HTTP to a non-loopback vault, because templates cross that hop', () => {
    expect(() =>
      loadConfig({ ...base, SIGNUP_OPEN: 'true', VAULT_URL: 'http://vault.internal:8090' }),
    ).toThrow(ConfigError);
  });

  it('allows plaintext to loopback, which is the intended shape', () => {
    const config = loadConfig({ ...base, SIGNUP_OPEN: 'true', VAULT_URL: 'http://127.0.0.1:8090' });
    expect(config.vaultUrl).toBe('http://127.0.0.1:8090');
  });

  it('binds loopback by default in production, so a loose firewall does not expose it', () => {
    expect(loadConfig({ ...base, SIGNUP_OPEN: 'true' }).host).toBe('127.0.0.1');
  });

  it('rejects a non-numeric port rather than listening on 0', () => {
    expect(() => loadConfig({ ...base, SIGNUP_OPEN: 'true', PORT: 'eighty' })).toThrow(ConfigError);
  });

  it('never puts a secret in what it prints at boot', async () => {
    const { describe: summarise } = await import('../src/config.js');
    const config = loadConfig({ ...base, SIGNUP_INVITE_TOKEN: 'a-token-of-at-least-24-chars' });
    expect(JSON.stringify(summarise(config))).not.toContain('a-token-of-at-least-24-chars');
    expect(JSON.stringify(summarise(config))).not.toContain('vt');
  });
});
