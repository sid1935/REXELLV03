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
import { similarity, toFaceVector } from './vector.js';

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
  /**
   * The sampled capture the claim is derived from.
   *
   * Optional in the type only so that the failure is a named reason rather
   * than a crash — a caller that omits it gets NO_EVIDENCE.
   */
  readonly frames?: readonly LivenessFrame[];
}

export type LivenessFailure =
  | 'CHALLENGE_UNKNOWN'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_ALREADY_USED'
  | 'NONCE_MISMATCH'
  | 'ACTION_NOT_COMPLETED'
  | 'PASSIVE_SCORE_TOO_LOW'
  | 'NO_EVIDENCE'
  | 'TOO_FEW_FRAMES'
  | 'TOO_BRIEF'
  | 'FRAMES_REPEATED'
  | 'NOT_ONE_PERSON'
  | 'NEVER_FACED_CAMERA'
  | 'MOVEMENT_NOT_OBSERVED';

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

  /*
   * Evidence, not assertion.
   *
   * `actionCompleted` used to be the whole check, and it is a boolean the
   * client sets — which means the client that skipped the camera entirely sets
   * it too. It is still read, because a client saying "I did not manage it" is
   * worth believing, but it can no longer be what says yes.
   */
  if (!response.actionCompleted) return { ok: false, reason: 'ACTION_NOT_COMPLETED' };
  if (!(response.passiveScore >= minPassiveScore)) return { ok: false, reason: 'PASSIVE_SCORE_TOO_LOW' };

  const evidence = judgeEvidence(challenge.kind, response.frames);
  if (!evidence.ok) return evidence;

  return { ok: true };
}

// ─── the evidence ────────────────────────────────────────────────────────────

/**
 * One sampled moment of a capture.
 *
 * Pose is measured in the browser from the 68 face landmarks, in raw image
 * space. `yaw` is positive when the nose sits toward the right of the image,
 * which is a person turned toward their own LEFT — verified against
 * photographs in both directions rather than reasoned about, because this is
 * the sign everybody gets backwards.
 */
export interface LivenessFrame {
  /** Milliseconds since the capture began. */
  readonly at: number;
  /** −1 fully to their right … +1 fully to their left. */
  readonly yaw: number;
  /** −1 looking up … +1 looking down. */
  readonly pitch: number;
  /** Eye aspect ratio. Around 0.3 open, near zero shut. */
  readonly eyeOpen: number;
  /** The descriptor for this frame, unit-normalised like any other. */
  readonly vector: readonly number[];
}

export interface EvidenceLimits {
  readonly minFrames: number;
  readonly minSpanMs: number;
  /** How far the head must actually turn, in yaw units. */
  readonly turn: number;
  /** How far it must travel through the nod, peak to trough. */
  readonly nod: number;
  /** Below this the eye counts as shut; above it, open. */
  readonly eyeShut: number;
  readonly eyeOpen: number;
  /** Any frame further from the camera than this does not count as facing it. */
  readonly centre: number;
  /**
   * How alike two frames of one capture must be.
   *
   * The loosest number here and the least well grounded, because it has to
   * survive a head turning far enough to change the descriptor substantially.
   * Set at the review threshold: a turned head must still beat a stranger
   * looking straight at the lens.
   */
  readonly samePerson: number;
  /**
   * Above this, two frames are the same capture submitted twice.
   *
   * Deliberately almost exactly 1. The check is for a sequence padded out with
   * copies of one frame, and a repeated frame scores exactly 1.0 against
   * itself. It is not a "these look similar" check: two real frames of somebody
   * holding very still reach 0.9999 easily, and a looser threshold here would
   * refuse the most cooperative users in the best light — which is the worst
   * possible group to fail.
   */
  readonly duplicate: number;
}

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = Object.freeze({
  minFrames: 8,
  minSpanMs: 1000,
  // Measured on photographs of people with turned heads, which reach 0.83 and
  // −0.84. A quarter of that is a movement nobody makes by accident and
  // everybody can make on request.
  turn: 0.25,
  nod: 0.4,
  eyeShut: 0.16,
  eyeOpen: 0.24,
  centre: 0.15,
  samePerson: 0.5,
  duplicate: 0.999999,
});

/**
 * Did this sequence come from a person doing what they were asked?
 *
 * ⚠ What this can and cannot do, because the difference matters more than the
 * code does.
 *
 * It defeats a photograph: paper does not turn its head, and a photograph held
 * at an angle from the start fails the "faced the camera first" check. It
 * defeats a video recorded in advance, because the server picks the movement
 * after the recording would have been made and there are four to choose from.
 * It defeats replaying a previous successful capture, because the nonce is
 * single-use and the frames must not be duplicates of each other.
 *
 * It does NOT defeat somebody who controls the client. Every number here is
 * measured in a browser we do not own, so a modified client can submit a
 * fabricated trajectory with a real descriptor and pass. Closing that needs
 * either frames the server can inspect itself or an attested client, and
 * neither is here. This raises the cost of the easy attacks from "print a
 * photograph" to "write code"; it is not a certified presentation-attack
 * detector and must not be described as one.
 */
export function judgeEvidence(
  kind: ChallengeKind,
  frames: readonly LivenessFrame[] | undefined,
  limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
): LivenessResult {
  if (!frames || !Array.isArray(frames)) return { ok: false, reason: 'NO_EVIDENCE' };
  if (frames.length < limits.minFrames) return { ok: false, reason: 'TOO_FEW_FRAMES' };

  const ordered = [...frames].sort((a, b) => a.at - b.at);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  if (last.at - first.at < limits.minSpanMs) return { ok: false, reason: 'TOO_BRIEF' };

  // Every frame must be a real, separate look at one person. The two failures
  // this catches are opposite: padding the sequence with copies of one frame,
  // and splicing in somebody else's face to borrow their movement.
  const vectors = ordered.map((f) => toFaceVector(f.vector));
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const s = similarity(vectors[i]!, vectors[j]!);
      if (s >= limits.duplicate) return { ok: false, reason: 'FRAMES_REPEATED' };
      if (s < limits.samePerson) return { ok: false, reason: 'NOT_ONE_PERSON' };
    }
  }

  // A movement is only a movement if it started from somewhere. Without this a
  // photograph held at a permanent angle satisfies "turn left" by existing.
  const centredAt = ordered.findIndex((f) => Math.abs(f.yaw) <= limits.centre && Math.abs(f.pitch) <= limits.centre * 2);
  if (centredAt < 0) return { ok: false, reason: 'NEVER_FACED_CAMERA' };

  // And it has to happen after that, not before.
  const after = ordered.slice(centredAt);
  const moved = (() => {
    switch (kind) {
      case 'turn_left':
        return after.some((f) => f.yaw >= limits.turn);
      case 'turn_right':
        return after.some((f) => f.yaw <= -limits.turn);
      case 'nod': {
        const pitches = after.map((f) => f.pitch);
        return Math.max(...pitches) - Math.min(...pitches) >= limits.nod;
      }
      case 'blink': {
        // Shut and then open again. A single frame with the eyes down is a
        // blur or a bad landmark fit; the recovery is what makes it a blink.
        const shutAt = after.findIndex((f) => f.eyeOpen <= limits.eyeShut);
        if (shutAt < 0) return false;
        return (
          after.slice(0, shutAt).some((f) => f.eyeOpen >= limits.eyeOpen) &&
          after.slice(shutAt).some((f) => f.eyeOpen >= limits.eyeOpen)
        );
      }
      default:
        return false;
    }
  })();

  if (!moved) return { ok: false, reason: 'MOVEMENT_NOT_OBSERVED' };
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
