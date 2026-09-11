/**
 * The capture loops, run start to finish against a fake camera.
 *
 * These two functions are the most user-facing code in the product — everything
 * a person does with their face goes through one of them — and until this file
 * they had no tests at all. The cost of that was not theoretical: a refactor
 * left `move` referenced but never declared in `captureAtGate`, `node --check`
 * saw nothing wrong because the syntax was fine, and the first thing to notice
 * was a lane at a live gate answering "Scan failed: move is not defined".
 *
 * The face model is stubbed, deliberately and completely. What is under test is
 * the loop: does it terminate, does it read the geometry, does it stop when the
 * movement is done, does it report failure rather than throwing, and does it
 * keep the resting pose it measures against. None of that needs a real network,
 * and requiring one is why it was never tested.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';

const DIMS = 128;

/**
 * A face at a given pose, in the shape face-api returns.
 *
 * The landmark points are synthesised so that `faceGeometry` recovers the yaw
 * and eye openness it was given — the geometry itself is exercised against real
 * photographs elsewhere; what matters here is that the loop reads it at all.
 */
function detection({ yaw = 0, eyeOpen = 0.3, size = 200 } = {}) {
  // faceGeometry: yaw = (toLeft - toRight) / width, measured from the nose tip
  // between the jaw extremes. Place the tip to produce the yaw asked for.
  const half = size / 2;
  const tipX = half + (yaw * size) / 2;
  const point = (x, y) => ({ x, y });
  const jaw = [point(0, 0), ...Array.from({ length: 15 }, (_, i) => point((i + 1) * (size / 16), 100)), point(size, 0)];
  // getJawOutline()[middle] is the chin, and pitch reads the tip between the
  // eye line and it. 0.4 of the way down is the resting value.
  jaw[Math.floor(jaw.length / 2)] = point(half, 100);
  const eye = (cx) => [
    point(cx - 10, 50), point(cx - 5, 50 - eyeOpen * 20), point(cx + 5, 50 - eyeOpen * 20),
    point(cx + 10, 50), point(cx + 5, 50 + eyeOpen * 20), point(cx - 5, 50 + eyeOpen * 20),
  ];
  return {
    detection: { box: { width: size, height: size }, score: 0.95 },
    descriptor: Float32Array.from({ length: DIMS }, (_, i) => Math.sin(i * 0.7 + yaw)),
    landmarks: {
      getJawOutline: () => jaw,
      getNose: () => Array.from({ length: 9 }, () => point(tipX, 70)),
      getLeftEye: () => eye(half - 30),
      getRightEye: () => eye(half + 30),
    },
  };
}

/** Installs a fake face-api that plays back a scripted sequence of poses. */
function stubFaceApi(poses) {
  let i = 0;
  globalThis.faceapi = {
    tf: { setBackend: async () => {}, ready: async () => {} },
    nets: {
      tinyFaceDetector: { loadFromUri: async () => {} },
      faceLandmark68TinyNet: { loadFromUri: async () => {} },
      faceRecognitionNet: { loadFromUri: async () => {} },
    },
    TinyFaceDetectorOptions: class {},
    detectAllFaces: () => {
      // The last pose repeats, so a loop that keeps asking keeps getting the
      // same answer rather than running off the end of the script.
      const pose = poses[Math.min(i, poses.length - 1)];
      i += 1;
      const found = pose === null ? [] : [detection(pose)];
      const chain = { withFaceLandmarks: () => chain, withFaceDescriptors: async () => found, then: undefined };
      // `await` on the chain must yield the array when descriptors are not asked
      // for, which is how the diagnostics page calls it.
      chain.then = (resolve) => resolve(found);
      return chain;
    },
  };
  return () => {
    delete globalThis.faceapi;
  };
}

/**
 * Pin the movement the lane picks.
 *
 * `pickGateChallenge` reads the platform CSPRNG, which is exactly right in
 * production and makes a test that scripts one direction pass or fail by luck —
 * the first version of this file did, and was green until it was not. Stubbing
 * the source of the choice is more honest than scripting a capture that happens
 * to satisfy all three.
 */
const KIND_BYTE = { turn_left: 0, turn_right: 1, nod: 2 };
function forceChallenge(kind) {
  const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  globalThis.crypto.getRandomValues = (a) => {
    a[0] = KIND_BYTE[kind];
    return a;
  };
  return () => {
    globalThis.crypto.getRandomValues = real;
  };
}

let restore = () => {};
let unforce = () => {};
afterEach(() => {
  restore();
  unforce();
});

/**
 * Fresh module per test.
 *
 * `readyFaceMatcher` memoises the loaded library in module scope, which is right
 * in a browser and wrong here: the second test would get the first test's stub
 * and its scripted poses.
 */
async function loadModule() {
  vi.resetModules();
  return import('../face-capture.js');
}

describe('the gate capture loop', () => {
  it('returns a pass when the head actually turns', async () => {
    // Rests off-centre on purpose: the bug that started all of this.
    const rest = 0.3;
    unforce = forceChallenge('turn_left');
    restore = stubFaceApi([
      ...Array.from({ length: 4 }, () => ({ yaw: rest })),
      ...Array.from({ length: 10 }, (_, i) => ({ yaw: rest + (i + 1) * 0.06 })),
    ]);
    const m = await loadModule();
    const r = await m.captureAtGate({ videoWidth: 640, videoHeight: 480 }, () => {}, { timeoutMs: 3000 });

    expect(r.liveness.passed).toBe(true);
    expect(r.vector).toHaveLength(DIMS);
    expect(r.liveness.frames).toBeGreaterThanOrEqual(5);
  });

  it('returns a failure rather than throwing when nothing moves', async () => {
    // A photograph. The lane still needs the vector — it has to know whether the
    // face matched AND whether it was live, and conflating them turns "we could
    // not tell" into "go away".
    restore = stubFaceApi([{ yaw: 0.1 }]);
    const m = await loadModule();
    const r = await m.captureAtGate({ videoWidth: 640, videoHeight: 480 }, () => {}, { timeoutMs: 600 });

    expect(r.liveness.passed).toBe(false);
    expect(r.vector).toHaveLength(DIMS);
  });

  it('throws only when it never saw a face at all', async () => {
    restore = stubFaceApi([null]);
    const m = await loadModule();
    await expect(
      m.captureAtGate({ videoWidth: 640, videoHeight: 480 }, () => {}, { timeoutMs: 400 }),
    ).rejects.toMatchObject({ code: 'NO_FACE' });
  });

  it('tells the operator how it is going', async () => {
    const said = [];
    unforce = forceChallenge('turn_left');
    restore = stubFaceApi([{ yaw: 0 }, { yaw: 0 }, { yaw: 0 }, { yaw: 0.1 }, { yaw: 0.1 }]);
    const m = await loadModule();
    await m.captureAtGate({ videoWidth: 640, videoHeight: 480 }, (s) => said.push(s), { timeoutMs: 600 });
    expect(said.some((s) => /keep going/.test(s)), said.join(' | ')).toBe(true);
  });

  it('keeps the resting pose once the frame buffer is full', async () => {
    // maxFrames trimming used to drop the oldest frame, which slid the baseline
    // along with the head — so a slow turn could never register, because the
    // thing it was measured against moved with it.
    unforce = forceChallenge('turn_left');
    restore = stubFaceApi([
      ...Array.from({ length: 3 }, () => ({ yaw: 0 })),
      ...Array.from({ length: 40 }, (_, i) => ({ yaw: Math.min(0.25, i * 0.01) })),
    ]);
    const m = await loadModule();
    const r = await m.captureAtGate({ videoWidth: 640, videoHeight: 480 }, () => {}, { timeoutMs: 3000, maxFrames: 8 });
    expect(r.liveness.passed).toBe(true);
  });
});

describe('the enrolment capture loop', () => {
  const challenge = { id: 'chl_1', nonce: 'n', kind: 'turn_left' };

  it('returns evidence when the movement is performed', async () => {
    restore = stubFaceApi([
      ...Array.from({ length: 4 }, () => ({ yaw: -0.25 })),
      ...Array.from({ length: 14 }, (_, i) => ({ yaw: -0.25 + (i + 1) * 0.05 })),
    ]);
    const m = await loadModule();
    const r = await m.captureLiveness({ videoWidth: 640, videoHeight: 480 }, challenge, () => {}, {
      timeoutMs: 5000,
      minSpanMs: 0,
    });

    expect(r.evidence.kind).toBe('turn_left');
    expect(r.evidence.frames.length).toBeGreaterThanOrEqual(8);
    expect(r.vector).toHaveLength(DIMS);
    // Every frame carries its own pose and its own descriptor — that is what
    // the vault re-derives the verdict from.
    for (const f of r.evidence.frames) {
      expect(f.vector).toHaveLength(DIMS);
      expect(typeof f.yaw).toBe('number');
      expect(typeof f.at).toBe('number');
    }
  });

  it('times out with an instruction rather than a stack trace', async () => {
    restore = stubFaceApi([{ yaw: 0 }]);
    const m = await loadModule();
    await expect(
      m.captureLiveness({ videoWidth: 640, videoHeight: 480 }, challenge, () => {}, { timeoutMs: 600 }),
    ).rejects.toMatchObject({ code: 'LIVENESS_TIMEOUT' });
  });

  it('enrols the most front-on frame, not the most turned one', async () => {
    restore = stubFaceApi([
      ...Array.from({ length: 4 }, () => ({ yaw: 0 })),
      ...Array.from({ length: 14 }, (_, i) => ({ yaw: (i + 1) * 0.05 })),
    ]);
    const m = await loadModule();
    const r = await m.captureLiveness({ videoWidth: 640, videoHeight: 480 }, challenge, () => {}, {
      timeoutMs: 5000,
      minSpanMs: 0,
    });
    /*
     * Against the evidence the loop kept, not against a descriptor rebuilt here.
     * Rebuilding it means reimplementing `unit` — which centres by the mean
     * descriptor before normalising — and the first version of this assertion
     * forgot that and failed for a reason that had nothing to do with frame
     * selection. Every frame carries its own vector, so ask the loop.
     */
    const flattest = r.evidence.frames.reduce((a, b) => (Math.abs(b.yaw) < Math.abs(a.yaw) ? b : a));
    expect(Math.abs(flattest.yaw)).toBeLessThan(0.05);
    expect(r.vector).toEqual(flattest.vector);
  });
});
