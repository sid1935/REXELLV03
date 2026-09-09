/**
 * Liveness, as a protocol rather than a score.
 *
 * The attack this defends against is not subtle: without it, enrolment is a POST
 * that accepts a template, so an attacker skips the camera entirely and enrols a
 * vector they obtained elsewhere. A passive liveness score computed on the client
 * and sent along does not help, because the client is the attacker.
 *
 * So the server issues a challenge first — a random nonce plus an action to
 * perform — and only accepts a capture that echoes that nonce, within its TTL,
 * once. That makes a captured template non-replayable even though everything
 * upstream of it is untrusted.
 *
 * The passive score is still carried, and still checked. It is a second signal,
 * not the mechanism.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const CHALLENGE_KINDS = ['blink', 'turn_left', 'turn_right', 'nod'] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

export const DEFAULT_CHALLENGE_TTL_MS = 60_000;
export const DEFAULT_MIN_PASSIVE_SCORE = 0.8;

export interface Challenge {
  readonly id: string;
  readonly kind: ChallengeKind;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ChallengeResponse {
  readonly challengeId: string;
  readonly nonce: string;
  /** Client-reported passive liveness in [0, 1]. A signal, never the control. */
  readonly passiveScore: number;
  /** Whether the client says the requested action was performed. */
  readonly actionCompleted: boolean;
}

export type LivenessFailure =
  | 'CHALLENGE_UNKNOWN'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_ALREADY_USED'
  | 'NONCE_MISMATCH'
  | 'ACTION_NOT_COMPLETED'
  | 'PASSIVE_SCORE_TOO_LOW';

export type LivenessResult = { readonly ok: true } | { readonly ok: false; readonly reason: LivenessFailure };

export function issueChallenge(
  seed: { id: string; nonce: string; kind: ChallengeKind },
  now: number,
  ttlMs: number = DEFAULT_CHALLENGE_TTL_MS,
): Challenge {
  return { id: seed.id, kind: seed.kind, nonce: seed.nonce, issuedAt: now, expiresAt: now + ttlMs };
}

/** Pick a challenge kind from random bytes, so the action cannot be predicted. */
export function pickKind(randomByte: number): ChallengeKind {
  return CHALLENGE_KINDS[randomByte % CHALLENGE_KINDS.length] as ChallengeKind;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyChallenge(
  challenge: Challenge | undefined,
  response: ChallengeResponse,
  now: number,
  minPassiveScore: number = DEFAULT_MIN_PASSIVE_SCORE,
): LivenessResult {
  if (!challenge) return { ok: false, reason: 'CHALLENGE_UNKNOWN' };
  if (now >= challenge.expiresAt) return { ok: false, reason: 'CHALLENGE_EXPIRED' };
  // Compared in constant time. The nonce is a secret for its sixty seconds, and
  // a length-or-prefix timing signal is a way to guess it.
  if (!constantTimeEquals(challenge.nonce, response.nonce)) return { ok: false, reason: 'NONCE_MISMATCH' };
  if (!response.actionCompleted) return { ok: false, reason: 'ACTION_NOT_COMPLETED' };
  if (!(response.passiveScore >= minPassiveScore)) return { ok: false, reason: 'PASSIVE_SCORE_TOO_LOW' };
  return { ok: true };
}

/**
 * Single-use challenge storage.
 *
 * Consumption happens on lookup, not on success, so a failed attempt burns the
 * challenge too. Otherwise an attacker retries the same nonce against different
 * templates until one lands.
 */
export class ChallengeStore {
  #live = new Map<string, Challenge>();

  put(challenge: Challenge): void {
    this.#live.set(challenge.id, challenge);
  }

  /** Returns the challenge and removes it. A second call for the same id gets nothing. */
  consume(id: string): Challenge | undefined {
    const found = this.#live.get(id);
    this.#live.delete(id);
    return found;
  }

  sweep(now: number): number {
    let removed = 0;
    for (const [id, c] of this.#live) {
      if (now >= c.expiresAt) {
        this.#live.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#live.size;
  }
}

/**
 * Binds a capture to the challenge that authorised it.
 *
 * The client sends this alongside the sealed template. It proves the template
 * was produced in response to this specific challenge and has not been swapped
 * for another one in transit.
 */
export function captureTag(nonce: string, sealedTemplate: Buffer, key: Buffer): string {
  return createHmac('sha256', key).update(nonce).update(sealedTemplate).digest('hex');
}

export function verifyCaptureTag(nonce: string, sealedTemplate: Buffer, key: Buffer, tag: string): boolean {
  const expected = captureTag(nonce, sealedTemplate, key);
  return constantTimeEquals(expected, tag);
}
