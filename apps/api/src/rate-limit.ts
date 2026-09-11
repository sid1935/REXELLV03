/**
 * Request throttling.
 *
 * A token bucket rather than a fixed window: a fixed window lets a caller spend
 * its whole allowance in the last second of one window and the whole of the
 * next in the first second of the next, which is twice the limit at exactly the
 * moment the limit matters. A bucket refills continuously and has no boundary
 * to exploit.
 *
 * This is per-process and in-memory. Two API instances behind a load balancer
 * therefore permit twice these numbers — the honest fix is a shared counter in
 * Redis, and it is not written because nothing else here is horizontally
 * scalable yet (SQLite via `node:sqlite` is one process). Deploying a second
 * instance means revisiting this file, and `docs/DEPLOYMENT.md` says so.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EpochMs } from '@rexell/domain';
import { HttpError } from './errors.js';

export interface Allowance {
  /** Sustained rate, in requests per second. */
  ratePerSecond: number;
  /** How much unused allowance can accumulate — the size of a permitted burst. */
  burst: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly allowance: Allowance) {}

  /**
   * Spend one token for `key`.
   *
   * Returns whether the caller may proceed and, when it may not, how long it
   * should wait — callers get a number rather than a bare refusal, because a
   * client that does not know when to retry retries immediately.
   */
  take(key: string, at: number): { ok: boolean; remaining: number; retryAfterMs: number } {
    const { ratePerSecond, burst } = this.allowance;
    const bucket = this.buckets.get(key) ?? { tokens: burst, updatedAt: at };

    // Refill for the elapsed time, capped at the burst size. Clamped at zero so
    // a clock that goes backwards cannot mint tokens.
    const elapsed = Math.max(0, at - bucket.updatedAt);
    bucket.tokens = Math.min(burst, bucket.tokens + (elapsed / 1000) * ratePerSecond);
    bucket.updatedAt = at;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      const deficit = 1 - bucket.tokens;
      return { ok: false, remaining: 0, retryAfterMs: Math.ceil((deficit / ratePerSecond) * 1000) };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return { ok: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
  }

  /**
   * Drop buckets that have refilled completely.
   *
   * Without this the map is a slow memory leak keyed by client IP, which is an
   * unbounded set. A full bucket is indistinguishable from one that never
   * existed, so forgetting it changes no decision.
   */
  sweep(at: number): number {
    const { ratePerSecond, burst } = this.allowance;
    const fullAfterMs = (burst / ratePerSecond) * 1000;
    let dropped = 0;
    for (const [key, bucket] of this.buckets) {
      if (at - bucket.updatedAt >= fullAfterMs) {
        this.buckets.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.buckets.size;
  }
}

export interface RateLimitOptions {
  /** Applied to every request, keyed by client address. */
  overall: Allowance;
  /**
   * Applied on top of `overall` to unauthenticated writes that bring something
   * into existence — organizer signup and event creation. These are the two
   * routes where an abusive caller costs storage rather than CPU.
   */
  creates: Allowance;
}

/**
 * The unauthenticated routes charged the stricter bucket.
 *
 * Two kinds. Organizer signup and event creation, where an abusive caller
 * costs storage; and recovery, where the abuse is guessing. A recovery code
 * carries 100 bits, so this is not what stops a brute force — it stops a
 * script pointing itself at the route and staying there.
 */
const CREATE_ROUTES = new Set([
  '/v1/organizers',
  '/v1/events',
  '/v1/identities/recover',
  // Face sign-in. It takes no identity and asserts nothing, so it is the one
  // door a script can stand in front of and keep pushing — and every push is a
  // 1:N search across every enrolled template, which is also the most
  // expensive thing an unauthenticated caller can ask this API to do.
  '/v1/identities/identify',
]);

export function registerRateLimit(
  app: FastifyInstance,
  options: RateLimitOptions,
  now: () => EpochMs,
): { overall: TokenBucket; creates: TokenBucket; sweep: () => void } {
  const overall = new TokenBucket(options.overall);
  const creates = new TokenBucket(options.creates);

  // `req.ip` is only as trustworthy as Fastify's `trustProxy` setting. Deployed
  // behind a proxy without it, every request appears to come from the proxy and
  // the whole world shares one bucket; deployed with it and directly reachable,
  // a caller sets its own key with a header. `server.ts` ties it to an env var
  // and `docs/DEPLOYMENT.md` explains which way round to set it.
  const keyOf = (req: FastifyRequest) => req.ip || 'unknown';

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const at = now();

    const path = (req.url.split('?')[0] ?? '').replace(/\/+$/, '') || '/';
    // A load balancer polls this every second or two and must never be told to
    // go away — a throttled health check reads as an outage.
    if (path === '/health') return;
    const isCreate = req.method === 'POST' && CREATE_ROUTES.has(path) && !req.headers['x-api-key'] && !req.headers.authorization;

    const verdict = isCreate ? creates.take(keyOf(req), at) : overall.take(keyOf(req), at);
    reply.header('x-ratelimit-remaining', String(verdict.remaining));

    if (!verdict.ok) {
      const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
      reply.header('retry-after', String(seconds));
      throw new HttpError(
        429,
        'RATE_LIMITED',
        `Too many requests. Try again in ${seconds}s.`,
        { retryAfterSeconds: seconds },
      );
    }
  });

  return {
    overall,
    creates,
    sweep: () => {
      const at = now();
      overall.sweep(at);
      creates.sweep(at);
    },
  };
}
