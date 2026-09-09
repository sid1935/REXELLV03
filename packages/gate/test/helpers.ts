import { randomBytes } from 'node:crypto';
import { VECTOR_DIMS, toFaceVector } from '@rexell/biometrics';
import type { FaceVector } from '@rexell/biometrics';
import { GateEngine, deriveManifestKey, generateDeviceKey, openManifest, sealManifest } from '../src/index.js';
import type { GateEntry, GateManifest } from '../src/index.js';

/** Deterministic synthetic faces, same construction as the vault tests. */
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

/** `jitter` is noise RMS as a fraction of signal RMS; cosine ≈ 1 / (1 + jitter²). */
export function capture(base: FaceVector, jitter = 0.2, seed = 7): FaceVector {
  const rand = lcg(Math.imul(seed, 48_271) + 11);
  const scale = (jitter / Math.sqrt(VECTOR_DIMS)) * Math.sqrt(3);
  const v = new Float32Array(VECTOR_DIMS);
  for (let i = 0; i < VECTOR_DIMS; i += 1) v[i] = (base[i] ?? 0) + (rand() * 2 - 1) * scale;
  return toFaceVector(v);
}

export const T0 = 1_780_000_000_000;
export const DOORS = T0 + 3_600_000;
export const EXPIRY = DOORS + 12 * 3_600_000;

export const MASTER = randomBytes(32);
export const SCANNER = 'scn_lane_a';
export const EVENT = 'evt_gate';

export function entry(i: number, over: Partial<GateEntry> = {}): GateEntry {
  return {
    ticketId: `tkt_${String(i).padStart(4, '0')}`,
    identityId: `idn_${String(i).padStart(4, '0')}`,
    tierId: 'tier_ga',
    gates: [],
    admitFrom: DOORS - 1_800_000,
    admitUntil: DOORS + 8 * 3_600_000,
    revoked: false,
    template: face(i),
    ...over,
  };
}

export function manifest(count: number, over: Partial<GateManifest> = {}): GateManifest {
  return {
    eventId: EVENT,
    scannerId: SCANNER,
    sequence: 0,
    generatedAt: DOORS - 7_200_000,
    expiresAt: EXPIRY,
    entries: Array.from({ length: count }, (_, i) => entry(i)),
    ...over,
  };
}

/** Seal and immediately reopen, so tests exercise the real wire format. */
export function roundTrip(m: GateManifest, now = DOORS): GateManifest {
  const key = deriveManifestKey(MASTER, m.scannerId, m.eventId, m.expiresAt);
  return openManifest(sealManifest(m, key), key, now, m.scannerId);
}

export function engine(m: GateManifest, over: Partial<ConstructorParameters<typeof GateEngine>[1]> = {}): GateEngine {
  const keys = generateDeviceKey();
  return new GateEngine(m, {
    scannerId: SCANNER,
    lane: 'lane_a',
    gateGroup: 'north',
    privateKeyPem: keys.privateKeyPem,
    allowReentry: false,
    ...over,
  });
}

export function deviceKeys() {
  return generateDeviceKey();
}
