import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The fair queue.
 *
 * Two jobs, and they are different jobs:
 *
 *  1. **Protect the origin.** A hot onsale is 50–500× baseline inside sixty
 *     seconds. The origin is sized for steady state and always will be, because
 *     sizing it for the spike means paying for the spike all year. So the edge
 *     absorbs the arrival rate and releases traffic at a rate the origin can
 *     actually serve.
 *
 *  2. **Make the queue winnable by a person.** A first-come-first-served queue
 *     is won by whoever can open the most connections at the moment it opens,
 *     which is a bot farm by definition. So a session's place is fixed by its
 *     first arrival and joining again does not improve it, and admission within
 *     a batch is drawn rather than ordered.
 *
 * The second is the one that matters commercially, and it is the one a naive
 * implementation gets wrong.
 */

export interface QueueConfig {
  /** Sessions released per second. Set to what the origin can serve, not more. */
  readonly drainPerSecond: number;
  /** How long an admission token is good for. */
  readonly tokenTtlMs: number;
  /** Signing key for admission tokens. */
  readonly secret: Buffer;
  /**
   * Admit in a random order within each batch rather than strictly by arrival.
   *
   * Strict arrival order rewards infrastructure: a farm that reaches the edge
   * four milliseconds sooner takes the whole front of the queue. A lottery
   * within the batch means being marginally faster buys nothing, so the farm has
   * to compete on account count instead — which is what the identity binding and
   * dedupe already cap.
   */
  readonly lottery?: boolean;
}

export interface JoinResult {
  readonly sessionId: string;
  readonly position: number;
  readonly ahead: number;
  readonly estimatedWaitMs: number;
  /** Present once admitted. Single use. */
  readonly token?: string;
  readonly rejoined: boolean;
}

export type RedeemFailure = 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'ALREADY_USED' | 'WRONG_SESSION';

export type RedeemResult = { readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly reason: RedeemFailure };

interface Waiting {
  readonly sessionId: string;
  readonly joinedAt: number;
  readonly key: string;
}

export class FairQueue {
  #waiting: Waiting[] = [];
  /** Dedupe key → the place it already holds. Rejoining changes nothing. */
  #held = new Map<string, Waiting>();
  #admitted = new Set<string>();
  #spent = new Set<string>();
  #lastDrainAt = 0;
  #totalArrivals = 0;
  #totalAdmitted = 0;
  #rejoins = 0;

  constructor(private readonly config: QueueConfig) {}

  /**
   * Join, or find the place you already have.
   *
   * `dedupeKey` is the identity if known, otherwise the device fingerprint. A
   * farm can still open many sessions — it just cannot use them to jump.
   */
  join(sessionId: string, dedupeKey: string, now: number): JoinResult {
    this.#totalArrivals += 1;

    const existing = this.#held.get(dedupeKey);
    if (existing) {
      this.#rejoins += 1;
      return this.#describe(existing, now, true);
    }

    // Start the drain clock at the first arrival. Starting it at the first
    // drain instead means the opening batch releases nobody, which at an onsale
    // is the one second everybody is watching.
    if (this.#lastDrainAt === 0) this.#lastDrainAt = now;

    const entry: Waiting = { sessionId, joinedAt: now, key: dedupeKey };
    this.#held.set(dedupeKey, entry);
    this.#waiting.push(entry);
    return this.#describe(entry, now, false);
  }

  #describe(entry: Waiting, now: number, rejoined: boolean): JoinResult {
    const index = this.#waiting.indexOf(entry);
    if (index === -1) {
      // Already drained. The token was handed out at admission time.
      return {
        sessionId: entry.sessionId,
        position: 0,
        ahead: 0,
        estimatedWaitMs: 0,
        rejoined,
        ...(this.#admitted.has(entry.sessionId) ? { token: this.issueToken(entry.sessionId, now) } : {}),
      };
    }
    return {
      sessionId: entry.sessionId,
      position: index + 1,
      ahead: index,
      estimatedWaitMs: Math.round((index / Math.max(1, this.config.drainPerSecond)) * 1000),
      rejoined,
    };
  }

  /**
   * Release whoever is due.
   *
   * Called on a timer. Releases at most `drainPerSecond × elapsed`, which is the
   * property that keeps the origin alive: however many arrive, this is the rate
   * that leaves.
   */
  drain(now: number): readonly string[] {
    if (this.#lastDrainAt === 0) {
      this.#lastDrainAt = now;
      return [];
    }
    const elapsedMs = Math.max(0, now - this.#lastDrainAt);
    const allowance = Math.floor((elapsedMs / 1000) * this.config.drainPerSecond);
    if (allowance <= 0) return [];

    this.#lastDrainAt = now;
    const batch = Math.min(allowance, this.#waiting.length);
    if (batch === 0) return [];

    let taken: Waiting[];
    if (this.config.lottery) {
      // Draw from the head of the queue rather than taking it in order, so
      // arriving four milliseconds earlier is worth nothing.
      const pool = this.#waiting.slice(0, Math.min(this.#waiting.length, batch * 3));
      taken = [];
      const indices = new Set<number>();
      while (taken.length < batch && indices.size < pool.length) {
        const i = Math.floor(Math.random() * pool.length);
        if (indices.has(i)) continue;
        indices.add(i);
        taken.push(pool[i] as Waiting);
      }
      const takenSet = new Set(taken);
      this.#waiting = this.#waiting.filter((w) => !takenSet.has(w));
    } else {
      taken = this.#waiting.splice(0, batch);
    }

    for (const w of taken) {
      this.#admitted.add(w.sessionId);
      this.#totalAdmitted += 1;
    }
    return taken.map((w) => w.sessionId);
  }

  /**
   * A signed, single-use admission token.
   *
   * Signed so the origin can trust it without a lookup — the edge and the origin
   * share only a key. Single-use so a farm cannot mint one admission into a
   * thousand purchases.
   */
  issueToken(sessionId: string, now: number): string {
    const expiresAt = now + this.config.tokenTtlMs;
    const nonce = randomBytes(9).toString('base64url');
    const body = `${sessionId}.${expiresAt}.${nonce}`;
    const mac = createHmac('sha256', this.config.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  redeem(token: string, sessionId: string, now: number): RedeemResult {
    const parts = token.split('.');
    if (parts.length !== 4) return { ok: false, reason: 'MALFORMED' };
    const [tokenSession, expiryRaw, nonce, mac] = parts as [string, string, string, string];

    const expected = createHmac('sha256', this.config.secret)
      .update(`${tokenSession}.${expiryRaw}.${nonce}`)
      .digest('base64url');
    const a = Buffer.from(expected);
    const b = Buffer.from(mac);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'BAD_SIGNATURE' };

    const expiresAt = Number(expiryRaw);
    if (!Number.isFinite(expiresAt) || now >= expiresAt) return { ok: false, reason: 'EXPIRED' };
    if (tokenSession !== sessionId) return { ok: false, reason: 'WRONG_SESSION' };
    if (this.#spent.has(nonce)) return { ok: false, reason: 'ALREADY_USED' };

    this.#spent.add(nonce);
    return { ok: true, sessionId: tokenSession };
  }

  isAdmitted(sessionId: string): boolean {
    return this.#admitted.has(sessionId);
  }

  status(now: number) {
    return {
      waiting: this.#waiting.length,
      admitted: this.#admitted.size,
      totalArrivals: this.#totalArrivals,
      totalAdmitted: this.#totalAdmitted,
      rejoins: this.#rejoins,
      drainPerSecond: this.config.drainPerSecond,
      estimatedDrainMs: Math.round((this.#waiting.length / Math.max(1, this.config.drainPerSecond)) * 1000),
      at: now,
    };
  }

  /** Drop expired nonces and stale sessions. Called on the same timer as drain. */
  sweep(): void {
    if (this.#spent.size > 200_000) this.#spent.clear();
  }
}
