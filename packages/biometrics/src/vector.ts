/**
 * Face templates as vectors.
 *
 * A template is a unit-normalised float vector, and comparison is cosine
 * similarity. That is the shape every production face-recognition SDK produces,
 * so the code around it — thresholds, dedupe, the review band, the gate decision
 * — is written against the real interface and does not change when the prototype
 * matcher is swapped for a licensed one.
 *
 * What does change is the numbers. See `thresholds.ts`.
 *
 * The property that matters most, and the one that kills the naive
 * hash-the-face-on-chain design: two captures of the same person produce
 * DIFFERENT vectors. Comparison is similarity, never equality. Nothing in this
 * package has an `equals`.
 */

export const VECTOR_DIMS = 128;

/** A unit-normalised embedding. Always length `VECTOR_DIMS`. */
export type FaceVector = Float32Array & { readonly __brand: 'FaceVector' };

export class VectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorError';
  }
}

export function toFaceVector(values: ArrayLike<number>): FaceVector {
  if (values.length !== VECTOR_DIMS) {
    throw new VectorError(`expected ${VECTOR_DIMS} dimensions, got ${values.length}`);
  }
  const v = new Float32Array(VECTOR_DIMS);
  let sumSquares = 0;
  for (let i = 0; i < VECTOR_DIMS; i += 1) {
    const x = values[i] ?? 0;
    if (!Number.isFinite(x)) throw new VectorError(`dimension ${i} is not finite`);
    v[i] = x;
    sumSquares += x * x;
  }
  const magnitude = Math.sqrt(sumSquares);
  if (magnitude === 0) throw new VectorError('cannot normalise a zero vector');
  for (let i = 0; i < VECTOR_DIMS; i += 1) v[i] = (v[i] ?? 0) / magnitude;
  return v as FaceVector;
}

/**
 * Cosine similarity of two unit vectors, which is just their dot product.
 *
 * Range is [-1, 1] in principle. Real face embeddings cluster well above zero,
 * so thresholds live in roughly [0.5, 0.9].
 */
export function similarity(a: FaceVector, b: FaceVector): number {
  let dot = 0;
  for (let i = 0; i < VECTOR_DIMS; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  // Floating point can nudge a self-comparison to 1.0000001, which then trips
  // range assertions downstream.
  return Math.max(-1, Math.min(1, dot));
}

export function serialise(v: FaceVector): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function deserialise(buffer: Buffer): FaceVector {
  if (buffer.byteLength !== VECTOR_DIMS * 4) {
    throw new VectorError(`expected ${VECTOR_DIMS * 4} bytes, got ${buffer.byteLength}`);
  }
  // Copy rather than view: a Buffer from a pool shares its backing store, and a
  // template aliasing a reused pool page is a data-leak bug waiting to happen.
  const copy = new Float32Array(VECTOR_DIMS);
  for (let i = 0; i < VECTOR_DIMS; i += 1) copy[i] = buffer.readFloatLE(i * 4);
  return copy as FaceVector;
}

/**
 * The model that produced a template.
 *
 * Stored alongside every template because vectors from different models are not
 * comparable. Upgrading the matcher means re-enrolling, and without this field
 * that upgrade silently starts denying everybody at the gate.
 */
export type ModelVersion = string;

export const PROTOTYPE_MODEL: ModelVersion = 'prototype-cosine-128-v1';
