import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ChallengeStore,
  DEFAULT_CHALLENGE_TTL_MS,
  PROTOTYPE_MODEL,
  PROTOTYPE_THRESHOLDS,
  SealingError,
  VECTOR_DIMS,
  VectorError,
  band,
  captureTag,
  deserialise,
  generateMasterKey,
  issueChallenge,
  seal,
  serialise,
  similarity,
  toFaceVector,
  unseal,
  validateThresholds,
  verifyCaptureTag,
  verifyChallenge,
} from '../src/index.js';
import type { Challenge, FaceVector } from '../src/index.js';
import * as biometrics from '../src/index.js';

function vec(fill: (i: number) => number): FaceVector {
  return toFaceVector(Array.from({ length: VECTOR_DIMS }, (_, i) => fill(i)));
}

describe('vectors', () => {
  it('normalises to unit length', () => {
    const v = vec((i) => i + 1);
    let sum = 0;
    for (let i = 0; i < VECTOR_DIMS; i += 1) sum += (v[i] ?? 0) ** 2;
    expect(sum).toBeCloseTo(1, 5);
  });

  it('scores a vector against itself as 1, and never above it', () => {
    const v = vec((i) => Math.sin(i));
    expect(similarity(v, v)).toBeLessThanOrEqual(1);
    expect(similarity(v, v)).toBeCloseTo(1, 6);
  });

  it('scores orthogonal vectors near zero', () => {
    const a = vec((i) => (i % 2 === 0 ? 1 : 0));
    const b = vec((i) => (i % 2 === 0 ? 0 : 1));
    expect(Math.abs(similarity(a, b))).toBeLessThan(1e-6);
  });

  it('refuses the wrong number of dimensions and a zero vector', () => {
    expect(() => toFaceVector([1, 2, 3])).toThrow(VectorError);
    expect(() => toFaceVector(new Array(VECTOR_DIMS).fill(0))).toThrow(/zero vector/);
    expect(() => toFaceVector(new Array(VECTOR_DIMS).fill(Number.NaN))).toThrow(/not finite/);
  });

  it('round-trips through bytes', () => {
    const v = vec((i) => Math.cos(i * 0.37));
    const back = deserialise(serialise(v));
    expect(similarity(v, back)).toBeCloseTo(1, 6);
  });

  it('copies on deserialise rather than aliasing the buffer', () => {
    const v = vec((i) => Math.cos(i));
    const bytes = serialise(v);
    const back = deserialise(bytes);
    bytes.fill(0);
    // If deserialise had returned a view, zeroing the buffer would have wrecked
    // the vector — and in a pooled Buffer that happens by accident.
    expect(Number.isFinite(back[0])).toBe(true);
    expect(similarity(back, back)).toBeCloseTo(1, 6);
  });

  it('exposes no equality comparison', () => {
    // The design depends on there being no way to ask "are these the same
    // template", because two captures of one face are never equal. If somebody
    // adds one, this fails and they have to explain why.
    const equalityShaped = Object.keys(biometrics).filter((k) => /equal|identical|same|matches$/i.test(k));
    expect(equalityShaped).toEqual([]);
  });
});

describe('thresholds', () => {
  it('bands scores into admit, review and no match', () => {
    expect(band(0.9)).toBe('match');
    expect(band(PROTOTYPE_THRESHOLDS.match)).toBe('match');
    expect(band(PROTOTYPE_THRESHOLDS.match - 0.001)).toBe('review');
    expect(band(PROTOTYPE_THRESHOLDS.review)).toBe('review');
    expect(band(PROTOTYPE_THRESHOLDS.review - 0.001)).toBe('no_match');
  });

  it('refuses a configuration with no review band', () => {
    // A single threshold forces a choice between admitting strangers and turning
    // away ticket-holders. The gap is the product.
    expect(() => validateThresholds({ match: 0.7, review: 0.7, dedupe: 0.7 })).toThrow(/no fallback band/);
    expect(() => validateThresholds({ match: 0.6, review: 0.8, dedupe: 0.7 })).toThrow();
  });

  it('accepts the prototype thresholds', () => {
    expect(() => validateThresholds(PROTOTYPE_THRESHOLDS)).not.toThrow();
  });
});

describe('liveness challenges', () => {
  const NOW = 1_000_000;
  const challenge: Challenge = issueChallenge({ id: 'chl_1', nonce: 'abc123', kind: 'blink' }, NOW);
  // A blink, performed. The nonce and the TTL are what these tests are about,
  // but the evidence has to be real or they would all fail on the wrong reason.
  const frames = Array.from({ length: 12 }, (_, i) => ({
    at: i * 180,
    yaw: 0,
    pitch: 0,
    eyeOpen: i === 7 || i === 8 ? 0.05 : 0.3,
    // One person, twelve separate looks: the same base vector nudged a
    // different way each frame, which is what a camera produces and what the
    // duplicate check requires the sequence not to lack.
    vector: [...vec((k) => Math.sin(k * 0.7) + 0.08 * Math.sin(k * 3.1 + (i + 1) * 1.7))],
  }));
  const good = { challengeId: 'chl_1', nonce: 'abc123', passiveScore: 0.95, actionCompleted: true, frames };

  it('accepts a correct response', () => {
    expect(verifyChallenge(challenge, good, NOW + 1000)).toEqual({ ok: true });
  });

  it('rejects an unknown challenge', () => {
    expect(verifyChallenge(undefined, good, NOW)).toMatchObject({ reason: 'CHALLENGE_UNKNOWN' });
  });

  it('rejects at the moment of expiry, not a moment after', () => {
    expect(verifyChallenge(challenge, good, NOW + DEFAULT_CHALLENGE_TTL_MS - 1).ok).toBe(true);
    expect(verifyChallenge(challenge, good, NOW + DEFAULT_CHALLENGE_TTL_MS)).toMatchObject({
      reason: 'CHALLENGE_EXPIRED',
    });
  });

  it('rejects a wrong nonce, including one that merely shares a prefix', () => {
    expect(verifyChallenge(challenge, { ...good, nonce: 'abc124' }, NOW)).toMatchObject({ reason: 'NONCE_MISMATCH' });
    expect(verifyChallenge(challenge, { ...good, nonce: 'abc' }, NOW)).toMatchObject({ reason: 'NONCE_MISMATCH' });
  });

  it('rejects a skipped action and a weak passive score', () => {
    expect(verifyChallenge(challenge, { ...good, actionCompleted: false }, NOW)).toMatchObject({
      reason: 'ACTION_NOT_COMPLETED',
    });
    expect(verifyChallenge(challenge, { ...good, passiveScore: 0.5 }, NOW)).toMatchObject({
      reason: 'PASSIVE_SCORE_TOO_LOW',
    });
  });
});

describe('the challenge store is single-use', () => {
  it('hands a challenge out once and then forgets it', () => {
    const store = new ChallengeStore();
    const c = issueChallenge({ id: 'chl_1', nonce: 'n', kind: 'nod' }, 0);
    store.put(c);

    expect(store.consume('chl_1')).toBe(c);
    // Consumed on lookup, not on success — a failed attempt burns it too, so an
    // attacker cannot retry one nonce against a series of templates.
    expect(store.consume('chl_1')).toBeUndefined();
  });

  it('sweeps expired challenges', () => {
    const store = new ChallengeStore();
    store.put(issueChallenge({ id: 'a', nonce: 'n', kind: 'blink' }, 0, 100));
    store.put(issueChallenge({ id: 'b', nonce: 'n', kind: 'blink' }, 0, 10_000));
    expect(store.sweep(500)).toBe(1);
    expect(store.size).toBe(1);
  });
});

describe('capture tags bind a template to its challenge', () => {
  const key = randomBytes(32);
  const template = Buffer.from('sealed-template-bytes');

  it('verifies a tag over the right nonce and bytes', () => {
    const tag = captureTag('nonce-1', template, key);
    expect(verifyCaptureTag('nonce-1', template, key, tag)).toBe(true);
  });

  it('rejects a template swapped in transit', () => {
    const tag = captureTag('nonce-1', template, key);
    expect(verifyCaptureTag('nonce-1', Buffer.from('somebody-elses-template'), key, tag)).toBe(false);
  });

  it('rejects a tag replayed under a different nonce', () => {
    const tag = captureTag('nonce-1', template, key);
    expect(verifyCaptureTag('nonce-2', template, key, tag)).toBe(false);
  });
});

describe('sealing', () => {
  const master = generateMasterKey();
  const v = vec((i) => Math.sin(i * 0.11) + 0.3);

  it('round-trips a template', () => {
    const sealed = seal(v, master, PROTOTYPE_MODEL);
    expect(similarity(unseal(sealed, master), v)).toBeCloseTo(1, 5);
  });

  it('produces different ciphertext each time for the same input', () => {
    // Deterministic ciphertext would let anyone with the table tell which two
    // accounts share a face, without decrypting anything.
    const a = seal(v, master, PROTOTYPE_MODEL);
    const b = seal(v, master, PROTOTYPE_MODEL);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedKey.equals(b.wrappedKey)).toBe(false);
  });

  it('refuses the wrong master key', () => {
    const sealed = seal(v, master, PROTOTYPE_MODEL);
    expect(() => unseal(sealed, generateMasterKey())).toThrow(SealingError);
  });

  it('detects tampering with the ciphertext, the wrapped key and the model tag', () => {
    const sealed = seal(v, master, PROTOTYPE_MODEL);

    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => unseal({ ...sealed, ciphertext: flipped }, master)).toThrow(SealingError);

    const badKey = Buffer.from(sealed.wrappedKey);
    badKey[0] = (badKey[0] ?? 0) ^ 0xff;
    expect(() => unseal({ ...sealed, wrappedKey: badKey }, master)).toThrow(SealingError);

    // Model version is authenticated data: relabelling a template is tampering.
    expect(() => unseal({ ...sealed, modelVersion: 'other-model' }, master)).toThrow(SealingError);
  });

  it('gives the same error whatever went wrong, so it is not an oracle', () => {
    const sealed = seal(v, master, PROTOTYPE_MODEL);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    const wrongKey = (() => {
      try {
        unseal(sealed, generateMasterKey());
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    const tamperedMessage = (() => {
      try {
        unseal({ ...sealed, ciphertext: tampered }, master);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();

    expect(wrongKey).toBe(tamperedMessage);
  });

  it('refuses a master key of the wrong size', () => {
    expect(() => seal(v, randomBytes(16), PROTOTYPE_MODEL)).toThrow(/32 bytes/);
  });
});
