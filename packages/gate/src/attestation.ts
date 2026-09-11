import { createPrivateKey, createPublicKey, createSign, generateKeyPairSync, verify as nodeVerify } from 'node:crypto';
import type { EntryCode, EntryOutcome } from '@rexell/domain';

/**
 * Signed entry attestations.
 *
 * Every decision a lane makes is signed by that device and queued. When the
 * network returns, the queue uploads and the server verifies each signature
 * against the key the device registered.
 *
 * Signed rather than merely authenticated, because the interesting question
 * after a disputed night is not "did this come from our infrastructure" but
 * "which device decided this, and can it deny it". A shared secret the server
 * also holds cannot answer the second question — the server could have written
 * the record itself.
 *
 * ECDSA P-256 rather than Ed25519: it is the curve WebCrypto supports
 * everywhere, and the scanner has to be able to do this in a browser.
 */

export interface DeviceKeyPair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

export interface Attestation {
  readonly ticketId: string;
  readonly identityId: string;
  readonly eventId: string;
  readonly lane: string;
  readonly decidedAt: number;
  readonly outcome: EntryOutcome;
  readonly code: EntryCode;
  readonly matchScore: number;
  readonly manifestSequence: number;
  readonly offline: boolean;
  /**
   * What the lane did about liveness, and what came of it.
   *
   * Part of the signed record rather than a local detail, because the question
   * asked after a disputed admission is not only "did the face match" but "was
   * anybody actually standing there". An attestation that cannot answer the
   * second is missing the half that a photograph would have exploited.
   *
   * `kind` is the movement this lane asked for, `passed` whether it saw it, and
   * `frames` how many looks it got. Absent means a lane running with the check
   * turned off — which is a legitimate configuration for a supervised turnstile
   * and must be distinguishable from a lane that checked and was satisfied.
   */
  readonly liveness?: AttestedLiveness;
}

export interface AttestedLiveness {
  readonly kind: string;
  readonly passed: boolean;
  readonly frames: number;
}

export interface SignedAttestation extends Attestation {
  readonly scannerId: string;
  /** base64 ECDSA signature over the canonical form below. */
  readonly signature: string;
}

export function generateDeviceKey(): DeviceKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/**
 * Canonical bytes to sign.
 *
 * Field order is fixed here rather than taken from JSON key order, because two
 * JSON serialisers that disagree about ordering would produce signatures that
 * verify on one machine and fail on another.
 */
export function canonicalAttestation(a: Attestation, scannerId: string): string {
  return [
    // v2 adds the liveness line. The version is in the signed bytes precisely so
    // that a v1 record cannot be reinterpreted as a v2 one with its liveness
    // field quietly missing — which would turn "this lane never checked" into
    // "this lane checked and said nothing", and those are different claims.
    'rexell-attestation-v2',
    scannerId,
    a.eventId,
    a.lane,
    a.ticketId,
    a.identityId,
    String(a.decidedAt),
    a.outcome,
    a.code,
    a.matchScore.toFixed(6),
    String(a.manifestSequence),
    a.offline ? '1' : '0',
    // "none" is a statement, not a blank: this lane was configured without the
    // check. It has to be signed like everything else, or an operator could
    // strip the field and claim the lane had been checking all along.
    a.liveness ? `${a.liveness.kind}:${a.liveness.passed ? 'pass' : 'fail'}:${a.liveness.frames}` : 'none',
  ].join('\n');
}

/**
 * A signature the caller supplies.
 *
 * Node signs synchronously with `createSign`. A browser cannot: WebCrypto's
 * ECDSA is async, so the scanner PWA signs at upload time rather than at scan
 * time. Both are equally non-repudiable — the device holds the only private key
 * either way — and deferring keeps an async round trip off the 800 ms path.
 *
 * What is NOT the same is the bytes. Node wraps (r, s) in DER; WebCrypto
 * concatenates them raw.  accepts both, because for a long
 * time it accepted only the first and therefore only ever verified signatures
 * made by tests.
 */
export type Signer = (message: string) => string;

export function signAttestation(a: Attestation, scannerId: string, privateKeyPem: string): SignedAttestation {
  const signer = createSign('sha256');
  signer.update(canonicalAttestation(a, scannerId));
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKeyPem)).toString('base64');
  return { ...a, scannerId, signature };
}

/**
 * Verify a device signature, in either of the two encodings ECDSA comes in.
 *
 * This is not a nicety. Node's `createSign` emits a DER-wrapped (r, s); the Web
 * Crypto API emits the raw concatenation, IEEE P1363, and there is no option to
 * make either produce the other. So a lane running in a browser — which is every
 * real lane — signed 64 bytes that Node's default verifier could never read, and
 * every attestation it uploaded was rejected as BAD_SIGNATURE.
 *
 * Nothing here is weakened by trying both. The bytes still have to verify under
 * the public key that device registered; the only question is how those bytes
 * are framed, and guessing wrong is indistinguishable from a forgery only
 * because both simply fail.
 */
export function verifyAttestation(a: SignedAttestation, publicKeyPem: string): boolean {
  const message = Buffer.from(canonicalAttestation(a, a.scannerId), 'utf8');
  const signature = Buffer.from(a.signature, 'base64');
  for (const dsaEncoding of ['der', 'ieee-p1363'] as const) {
    try {
      const key = { key: createPublicKey(publicKeyPem), dsaEncoding };
      if (nodeVerify('sha256', message, key, signature)) return true;
    } catch {
      // A malformed signature throws for one encoding and merely fails for the
      // other. Neither is an error worth propagating: both mean "not verified".
    }
  }
  return false;
}

/**
 * The upload queue.
 *
 * Bounded, because a scanner offline for six hours at a busy gate would
 * otherwise exhaust its own storage. When the bound is hit the OLDEST entries
 * are dropped and the loss is counted — losing the start of the night is better
 * than losing the ability to record the rest of it, and a silent drop would make
 * reconciliation lie.
 */
export class AttestationQueue {
  #items: SignedAttestation[] = [];
  #dropped = 0;

  constructor(private readonly capacity = 20_000) {}

  add(a: SignedAttestation): void {
    this.#items.push(a);
    if (this.#items.length > this.capacity) {
      this.#items.splice(0, this.#items.length - this.capacity);
      this.#dropped += 1;
    }
  }

  /** Take up to `limit` for upload. They stay queued until acknowledged. */
  peek(limit = 500): readonly SignedAttestation[] {
    return this.#items.slice(0, limit);
  }

  /** Drop what the server confirmed it stored. Anything else is retried. */
  acknowledge(count: number): void {
    this.#items.splice(0, count);
  }

  get pending(): number {
    return this.#items.length;
  }

  get dropped(): number {
    return this.#dropped;
  }
}
