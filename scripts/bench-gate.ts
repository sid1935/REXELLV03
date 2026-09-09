/**
 * Gate latency benchmark.
 *
 *   npm run bench:gate
 *
 * Measures the part of the 800 ms budget that ReXell's own code owns: the 1:N
 * match against the event gallery, the policy checks, and signing the
 * attestation. It does NOT measure camera capture, liveness or embedding — those
 * are the other ~310 ms of the budget and they belong to the device's camera
 * stack and the recognition SDK.
 *
 * ⚠ The number this prints on a laptop is not the exit criterion. The criterion
 * is p95 under 800 ms end to end on a mid-range Android device, and it is not met
 * until this has been run on one. What a laptop run gives you is the shape of the
 * curve against gallery size — which is what tells you whether 12,000 credentials
 * is tractable at all before anyone buys hardware.
 */
import { generateDeviceKey } from '@rexell/gate';
import { GateEngine } from '@rexell/gate';
import type { GateEntry, GateManifest } from '@rexell/gate';
import { VECTOR_DIMS, toFaceVector } from '@rexell/biometrics';
import type { FaceVector } from '@rexell/biometrics';

const T0 = 1_780_000_000_000;
const DOORS = T0 + 3_600_000;

function lcg(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = (Math.imul(s, 1_103_515_245) + 12_345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function face(seed: number): FaceVector {
  const rand = lcg(Math.imul(seed, 2_654_435_761) + 1);
  const v = new Float32Array(VECTOR_DIMS);
  for (let i = 0; i < VECTOR_DIMS; i += 1) v[i] = rand() * 2 - 1;
  return toFaceVector(v);
}

function capture(base: FaceVector, seed: number): FaceVector {
  const rand = lcg(Math.imul(seed, 48_271) + 11);
  const scale = (0.2 / Math.sqrt(VECTOR_DIMS)) * Math.sqrt(3);
  const v = new Float32Array(VECTOR_DIMS);
  for (let i = 0; i < VECTOR_DIMS; i += 1) v[i] = (base[i] ?? 0) + (rand() * 2 - 1) * scale;
  return toFaceVector(v);
}

function buildManifest(size: number): GateManifest {
  const entries: GateEntry[] = Array.from({ length: size }, (_, i) => ({
    ticketId: `tkt_${i}`,
    identityId: `idn_${i}`,
    tierId: 'tier_ga',
    gates: [],
    admitFrom: DOORS - 1_800_000,
    admitUntil: DOORS + 8 * 3_600_000,
    revoked: false,
    template: face(i),
  }));
  return {
    eventId: 'evt_bench',
    scannerId: 'scn_bench',
    sequence: 0,
    generatedAt: DOORS,
    expiresAt: DOORS + 12 * 3_600_000,
    entries,
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? 0;
}

const SIZES = [1_000, 5_000, 12_000, 25_000];
const SCANS = 200;
const BUDGET_MS = 800;
/** What capture, liveness and embedding are expected to cost. Architecture §06. */
const DEVICE_BUDGET_MS = 370;

console.log('\n  Gate decision latency — match, policy and signing only');
console.log(`  ${SCANS} scans per gallery size, on ${process.platform}/${process.arch}, node ${process.versions.node}\n`);
console.log('  gallery      p50       p95       p99       max    per-credential');
console.log('  ' + '─'.repeat(66));

const results: Array<{ size: number; p95: number }> = [];

for (const size of SIZES) {
  const keys = generateDeviceKey();
  const engine = new GateEngine(buildManifest(size), {
    scannerId: 'scn_bench',
    lane: 'lane_bench',
    gateGroup: 'main',
    privateKeyPem: keys.privateKeyPem,
    allowReentry: true, // so repeat scans measure the full path, not an early deny
  });

  // Warm the JIT. Without this the first samples measure compilation.
  for (let i = 0; i < 20; i += 1) engine.scan(capture(face(i), i), DOORS);

  const samples: number[] = [];
  for (let i = 0; i < SCANS; i += 1) {
    samples.push(engine.scan(capture(face(i % size), i + 1000), DOORS).elapsedMs);
  }
  samples.sort((a, b) => a - b);

  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const p99 = percentile(samples, 0.99);
  const max = samples[samples.length - 1] ?? 0;
  results.push({ size, p95 });

  const perCredential = (p50 / size) * 1000; // microseconds
  console.log(
    `  ${String(size).padStart(6)}  ${p50.toFixed(2).padStart(8)}ms ${p95.toFixed(2).padStart(8)}ms ` +
      `${p99.toFixed(2).padStart(8)}ms ${max.toFixed(2).padStart(8)}ms   ${perCredential.toFixed(2)}µs`,
  );
}

const festival = results.find((r) => r.size === 12_000);
const headroom = BUDGET_MS - DEVICE_BUDGET_MS - (festival?.p95 ?? 0);

console.log('\n  At a 12,000-capacity festival');
console.log(`    our p95              ${(festival?.p95 ?? 0).toFixed(1)} ms`);
console.log(`    camera + embedding   ~${DEVICE_BUDGET_MS} ms  (device, not measured here)`);
console.log(`    budget               ${BUDGET_MS} ms`);
console.log(`    headroom             ${headroom.toFixed(1)} ms`);

const scaling = results.length >= 2 ? results[results.length - 1]!.p95 / (results[0]!.p95 || 1) : 0;
const sizeRatio = SIZES[SIZES.length - 1]! / SIZES[0]!;
console.log(`\n    scaling              ${scaling.toFixed(1)}× time for ${sizeRatio}× gallery`);
console.log(
  scaling <= sizeRatio * 1.5
    ? '                         linear, as a 1:N scan should be'
    : '                         WORSE THAN LINEAR — something is quadratic, investigate',
);

console.log('\n  ⚠ Not the exit criterion. That is p95 under 800 ms end to end on a');
console.log('    mid-range Android device, and it stays unmet until measured there.\n');

if (headroom < 0) {
  console.log('  FAIL: no headroom left for capture and embedding at festival scale.\n');
  process.exit(1);
}
