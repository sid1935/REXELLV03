import { createPrivateKey, createPublicKey, createSign, createVerify, generateKeyPairSync } from 'node:crypto';
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
    'rexell-attestation-v1',
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
  ].join('\n');
}

/**
 * A signature the caller supplies.
 *
 * Node signs synchronously with `createSign`. A browser cannot: WebCrypto's
 * ECDSA is async, so the scanner PWA signs at upload time rather than at scan
 * time. Both are equally non-repudiable — the device holds the only private key
 * either way — and deferring keeps an async round trip off the 800 ms path.
 */
export type Signer = (message: string) => string;

export function signAttestation(a: Attestation, scannerId: string, privateKeyPem: string): SignedAttestation {
  const signer = createSign('sha256');
  signer.update(canonicalAttestation(a, scannerId));
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKeyPem)).toString('base64');
  return { ...a, scannerId, signature };
}

export function verifyAttestation(a: SignedAttestation, publicKeyPem: string): boolean {
  try {
    const verifier = createVerify('sha256');
    verifier.update(canonicalAttestation(a, a.scannerId));
    verifier.end();
    return verifier.verify(createPublicKey(publicKeyPem), Buffer.from(a.signature, 'base64'));
  } catch {
    return false;
  }
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
