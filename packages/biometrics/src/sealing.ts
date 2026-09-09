/**
 * Envelope encryption for templates at rest.
 *
 * Every template gets its own random data key; that data key is wrapped by a
 * master key the vault holds and no application service ever sees. In production
 * the master key is an HSM-backed KMS key with split custody and the unwrap is a
 * KMS call, so the plaintext data key exists only in vault memory for the
 * duration of one comparison.
 *
 * Why bother, when the vault also owns the database? Because the two are stolen
 * separately. A leaked backup, a snapshot copied to a laptop, a decommissioned
 * disk — all of those yield the table without the master key.
 *
 * AES-256-GCM throughout, so tampering is detected rather than decrypted into
 * garbage that then gets compared against somebody's face.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { FaceVector, ModelVersion } from './vector.js';
import { deserialise, serialise } from './vector.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface SealedTemplate {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly wrappedKey: Buffer;
  readonly wrapIv: Buffer;
  readonly wrapTag: Buffer;
  readonly modelVersion: ModelVersion;
}

export class SealingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealingError';
  }
}

export function generateMasterKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function seal(vector: FaceVector, masterKey: Buffer, modelVersion: ModelVersion): SealedTemplate {
  assertKey(masterKey);

  const dataKey = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataKey, iv);
  // The model version is authenticated but not encrypted: the vault must be able
  // to reject a stale-model template without unwrapping anything.
  cipher.setAAD(Buffer.from(modelVersion, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(serialise(vector)), cipher.final()]);
  const tag = cipher.getAuthTag();

  const wrapIv = randomBytes(IV_BYTES);
  const wrapper = createCipheriv(ALGORITHM, masterKey, wrapIv);
  const wrappedKey = Buffer.concat([wrapper.update(dataKey), wrapper.final()]);
  const wrapTag = wrapper.getAuthTag();

  dataKey.fill(0);

  return { ciphertext, iv, tag, wrappedKey, wrapIv, wrapTag, modelVersion };
}

export function unseal(sealed: SealedTemplate, masterKey: Buffer): FaceVector {
  assertKey(masterKey);

  let dataKey: Buffer | undefined;
  try {
    const unwrapper = createDecipheriv(ALGORITHM, masterKey, sealed.wrapIv);
    unwrapper.setAuthTag(sealed.wrapTag);
    dataKey = Buffer.concat([unwrapper.update(sealed.wrappedKey), unwrapper.final()]);

    const decipher = createDecipheriv(ALGORITHM, dataKey, sealed.iv);
    decipher.setAAD(Buffer.from(sealed.modelVersion, 'utf8'));
    decipher.setAuthTag(sealed.tag);
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    return deserialise(plaintext);
  } catch (cause) {
    // Never surface the underlying crypto error. It distinguishes "wrong key"
    // from "tampered ciphertext", which is an oracle.
    throw new SealingError('template could not be unsealed');
  } finally {
    dataKey?.fill(0);
  }
}

function assertKey(key: Buffer): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new SealingError(`master key must be ${KEY_BYTES} bytes, got ${key.byteLength}`);
  }
}

/** Flat row form, for a database that stores blobs rather than objects. */
export interface SealedRow {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  wrapped_key: Uint8Array;
  wrap_iv: Uint8Array;
  wrap_tag: Uint8Array;
  model_version: string;
}

export function toRow(s: SealedTemplate): SealedRow {
  return {
    ciphertext: s.ciphertext,
    iv: s.iv,
    tag: s.tag,
    wrapped_key: s.wrappedKey,
    wrap_iv: s.wrapIv,
    wrap_tag: s.wrapTag,
    model_version: s.modelVersion,
  };
}

export function fromRow(r: SealedRow): SealedTemplate {
  return {
    ciphertext: Buffer.from(r.ciphertext),
    iv: Buffer.from(r.iv),
    tag: Buffer.from(r.tag),
    wrappedKey: Buffer.from(r.wrapped_key),
    wrapIv: Buffer.from(r.wrap_iv),
    wrapTag: Buffer.from(r.wrap_tag),
    modelVersion: r.model_version,
  };
}
