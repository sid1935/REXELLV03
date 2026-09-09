import { VECTOR_DIMS, toFaceVector } from '@rexell/biometrics';
import type { FaceVector } from '@rexell/biometrics';
import type { VaultApp } from '../src/app.js';

/**
 * A synthetic face.
 *
 * Deterministic per seed, so tests are reproducible, but `capture()` adds noise
 * every time — which is the property that matters. Two captures of the same
 * person are never the same vector, so nothing in the system can be written to
 * compare templates for equality.
 */
/** Math.imul keeps the LCG in int32, where it belongs — plain `*` loses bits past 2^53. */
function lcg(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = (Math.imul(s, 1_103_515_245) + 12_345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function face(seed: number): FaceVector {
  const rand = lcg(Math.imul(seed, 2_654_435_761) + 1);
  const v = new Float32Array(VECTOR_DIMS);
  for (let i = 0; i < VECTOR_DIMS; i += 1) v[i] = rand() * 2 - 1;
  return toFaceVector(v);
}

/**
 * One capture of a face, with sensor noise.
 *
 * `jitter` is noise RMS as a fraction of signal RMS, so it is scale-free and
 * survives the fact that `face()` hands back a normalised vector. For two
 * captures of one person the resulting cosine is about `1 / (1 + jitter²)`:
 *
 *     jitter 0.2   →  ~0.96   comfortably a match
 *     jitter 0.75  →  ~0.64   the review band, where a human decides
 *     a different face  →  ~0  no match
 *
 * Those three regimes are exactly what the gate has to handle, which is why the
 * generator is written to hit them predictably rather than realistically.
 */
export function capture(base: FaceVector, jitter = 0.25, seed = 7): FaceVector {
  const rand = lcg(Math.imul(seed, 48_271) + 11);
  // Signal RMS for a unit vector of this many dimensions.
  const scale = jitter / Math.sqrt(VECTOR_DIMS);
  const v = new Float32Array(VECTOR_DIMS);
  for (let i = 0; i < VECTOR_DIMS; i += 1) {
    v[i] = (base[i] ?? 0) + (rand() * 2 - 1) * Math.sqrt(3) * scale;
  }
  return toFaceVector(v);
}

/** Run the full challenge → enrol handshake. */
export async function enrol(
  vault: VaultApp,
  identityId: string,
  scope: string,
  faceVector: FaceVector,
  opts: { jitter?: number; consentId?: string } = {},
) {
  const challenge = (
    await vault.server.inject({ method: 'POST', url: '/v1/challenges', payload: {} })
  ).json();

  return vault.server.inject({
    method: 'POST',
    url: '/v1/enrol',
    payload: {
      identityId,
      scope,
      consentId: opts.consentId ?? 'con_test',
      vector: [...capture(faceVector, opts.jitter ?? 0.2)],
      liveness: {
        challengeId: challenge.id,
        nonce: challenge.nonce,
        passiveScore: 0.95,
        actionCompleted: true,
      },
    },
  });
}
