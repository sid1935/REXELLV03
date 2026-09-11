import { VECTOR_DIMS, toFaceVector } from '@rexell/biometrics';
import type { ChallengeKind, FaceVector, LivenessFrame } from '@rexell/biometrics';
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
        frames: livenessFrames(challenge.kind, faceVector),
      },
    },
  });
}

/**
 * A liveness capture that satisfies the challenge it was asked.
 *
 * Every test that enrols goes through this rather than round a bypass, so the
 * evidence path is exercised by the whole suite instead of only by the tests
 * written for it. The sequence is deliberately ordinary: square on for the
 * first few frames, then the movement, over two seconds.
 *
 * Each frame is a fresh `capture()` of the same synthetic face, which is what
 * makes it one person and twelve separate looks at them — the two things the
 * server checks and the two things a fabricated sequence gets wrong.
 */
export function livenessFrames(kind: ChallengeKind, face: FaceVector, frames = 12): LivenessFrame[] {
  return Array.from({ length: frames }, (_, i) => {
    // Hold the centre for a moment, so the movement has somewhere to start.
    const t = Math.max(0, (i - 3) / (frames - 4));
    return {
      at: i * 180,
      yaw: kind === 'turn_left' ? t * 0.5 : kind === 'turn_right' ? -t * 0.5 : 0,
      pitch: kind === 'nod' ? t * 0.6 : 0,
      eyeOpen: kind === 'blink' && (i === 7 || i === 8) ? 0.05 : 0.3,
      vector: [...capture(face, 0.05, i + 1)],
    };
  });
}
