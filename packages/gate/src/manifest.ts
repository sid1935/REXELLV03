import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { VECTOR_DIMS, deserialise, serialise, toFaceVector } from '@rexell/biometrics';
import type { FaceVector } from '@rexell/biometrics';

/**
 * The sealed event manifest.
 *
 * This is the one path by which template material leaves the vault, and every
 * property of it is a containment decision:
 *
 *   scoped   — one event, one gate group. A scanner stolen from a stadium yields
 *              that night's ticket-holders and nobody else.
 *   sealed   — AES-256-GCM under a key derived per (scanner, event, expiry). The
 *              blob can be distributed days early over any channel; it is inert.
 *   keyed    — the key is released separately, on a schedule tied to doors-open.
 *              A manifest copied in transit is useless until that release, and
 *              the release is refused outside its window.
 *   expiring — the expiry is authenticated data, so it cannot be extended by
 *              editing the envelope. After it, the scanner erases and reports.
 *
 * The `no read path` property from M2 survives this: what crosses the wire is
 * ciphertext addressed to one device for one night, never a readable template.
 */

export interface GateCredential {
  readonly ticketId: string;
  readonly identityId: string;
  readonly tierId: string;
  readonly seat?: string;
  /** Gate groups this credential opens. Empty means every gate. */
  readonly gates: readonly string[];
  readonly admitFrom: number;
  readonly admitUntil: number;
  readonly revoked: boolean;
}

/** A credential plus the template the scanner matches against, in memory only. */
export interface GateEntry extends GateCredential {
  readonly template: FaceVector;
}

export interface GateManifest {
  readonly eventId: string;
  readonly scannerId: string;
  readonly sequence: number;
  readonly generatedAt: number;
  readonly expiresAt: number;
  readonly entries: readonly GateEntry[];
}

export interface SealedManifest {
  readonly eventId: string;
  readonly scannerId: string;
  readonly sequence: number;
  readonly generatedAt: number;
  readonly expiresAt: number;
  readonly count: number;
  /** base64. Opaque without the key, which is released separately. */
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

export class ManifestError extends Error {
  constructor(
    message: string,
    readonly code: 'EXPIRED' | 'WRONG_KEY' | 'TAMPERED' | 'WRONG_DEVICE',
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * Derive the key for exactly one (scanner, event, expiry) triple.
 *
 * Binding the expiry into the derivation is what stops an operator extending a
 * manifest's life by editing a field: a different expiry is a different key, and
 * the ciphertext will not open under it.
 */
export function deriveManifestKey(
  masterKey: Buffer,
  scannerId: string,
  eventId: string,
  expiresAt: number,
): Buffer {
  const info = Buffer.from(`rexell-manifest|${scannerId}|${eventId}|${expiresAt}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), info, 32));
}

function aad(m: { eventId: string; scannerId: string; sequence: number; expiresAt: number }): Buffer {
  return Buffer.from(`${m.eventId}|${m.scannerId}|${m.sequence}|${m.expiresAt}`, 'utf8');
}

export function sealManifest(manifest: GateManifest, key: Buffer): SealedManifest {
  const payload = Buffer.from(
    JSON.stringify(
      manifest.entries.map((e) => ({
        t: e.ticketId,
        i: e.identityId,
        r: e.tierId,
        s: e.seat ?? null,
        g: e.gates,
        f: e.admitFrom,
        u: e.admitUntil,
        v: e.revoked,
        // Templates travel as base64 float bytes, not as JSON number arrays —
        // a 12,000-entry manifest of 128-float arrays is megabytes of decimal text.
        b: serialise(e.template).toString('base64'),
      })),
    ),
    'utf8',
  );

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(manifest));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);

  return {
    eventId: manifest.eventId,
    scannerId: manifest.scannerId,
    sequence: manifest.sequence,
    generatedAt: manifest.generatedAt,
    expiresAt: manifest.expiresAt,
    count: manifest.entries.length,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function openManifest(
  sealed: SealedManifest,
  key: Buffer,
  now: number,
  scannerId?: string,
): GateManifest {
  // Checked before any decryption. An expired manifest must not be openable even
  // by a device holding a valid key.
  if (now >= sealed.expiresAt) {
    throw new ManifestError('this manifest has expired and must be erased', 'EXPIRED');
  }
  if (scannerId !== undefined && scannerId !== sealed.scannerId) {
    throw new ManifestError('this manifest was not issued to this device', 'WRONG_DEVICE');
  }

  let payload: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(aad(sealed));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    payload = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]);
  } catch {
    // One error for every failure. Distinguishing "wrong key" from "tampered"
    // would make this an oracle.
    throw new ManifestError('manifest could not be opened', 'WRONG_KEY');
  }

  const rows = JSON.parse(payload.toString('utf8')) as Array<{
    t: string;
    i: string;
    r: string;
    s: string | null;
    g: string[];
    f: number;
    u: number;
    v: boolean;
    b: string;
  }>;

  return {
    eventId: sealed.eventId,
    scannerId: sealed.scannerId,
    sequence: sealed.sequence,
    generatedAt: sealed.generatedAt,
    expiresAt: sealed.expiresAt,
    entries: rows.map((r) => ({
      ticketId: r.t,
      identityId: r.i,
      tierId: r.r,
      ...(r.s !== null ? { seat: r.s } : {}),
      gates: r.g,
      admitFrom: r.f,
      admitUntil: r.u,
      revoked: r.v,
      template: deserialise(Buffer.from(r.b, 'base64')),
    })),
  };
}

/** Convenience for building a manifest entry from a raw vector. */
export function credentialWithTemplate(credential: GateCredential, values: ArrayLike<number>): GateEntry {
  if (values.length !== VECTOR_DIMS) {
    throw new ManifestError(`template must have ${VECTOR_DIMS} dimensions`, 'TAMPERED');
  }
  return { ...credential, template: toFaceVector(values) };
}
