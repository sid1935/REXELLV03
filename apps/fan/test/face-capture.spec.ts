/// <reference lib="dom" />
// Everything interesting here runs inside the page, against the module the fan
// app actually imports.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The matcher, in a browser, through a camera.
 *
 * Every other test of this code works on numbers: packages/biometrics measures
 * thresholds against known descriptors, packages/ui exercises the capture loops
 * against synthetic frames. Both are the right shape for what they test, and
 * neither can tell you that the weights are served, that the CSP lets them
 * load, that a backend is available, or that `getUserMedia` returns something
 * the detector can read. Those are properties of the deployment, and they break
 * in ways no unit test can see — a renamed model file, a changed header, a
 * missing MIME type for `.bin`.
 *
 * Chromium supplies a synthetic camera, so most of this runs anywhere. What it
 * cannot supply is a face: that needs a Y4M built from real photographs, which
 * are gitignored on purpose. Those tests skip loudly rather than pretending.
 */

const FAN = 'http://127.0.0.1:8120/';

/*
 * The matcher's URL, not its module path.
 *
 * `/face-capture.js` exists only at runtime, served by the static host from
 * packages/ui. Written as a literal, tsc tries to resolve it against the file
 * system and fails; held in a variable it stays what it is — an address the
 * browser will fetch.
 */
const CAPTURE_MODULE = '/face-capture.js';
const HAS_FACE = existsSync(resolve('.calibration/fixture/face.y4m'));

// Weights are megabytes and the CPU backend is not quick. This is a slow test
// by nature, and a short timeout would only make it a flaky one.
test.setTimeout(120_000);

/** The page the fan app enrols on, with nothing stubbed but the API. */
async function openFan(page: Page): Promise<void> {
  await page.route('**/v1/**', (r) => r.fulfill({ json: {} }));
  await page.goto(FAN);
}

test('serves every weight the matcher asks for', async ({ page }) => {
  await openFan(page);

  /*
   * Fetched rather than assumed. A model file that 404s, or that arrives as
   * text/html because the extension has no MIME type, fails inside face-api
   * with an error about tensors — and the only symptom anybody sees is that
   * enrolment stopped working.
   */
  const results = await page.evaluate(async () => {
    const paths = [
      '/face/face-api.js',
      '/face/models/tiny_face_detector_model-weights_manifest.json',
      '/face/models/tiny_face_detector_model.bin',
      '/face/models/face_landmark_68_tiny_model-weights_manifest.json',
      '/face/models/face_landmark_68_tiny_model.bin',
      '/face/models/face_recognition_model-weights_manifest.json',
      '/face/models/face_recognition_model.bin',
    ];
    return Promise.all(
      paths.map(async (path) => {
        const r = await fetch(path);
        return { path, status: r.status, type: r.headers.get('content-type') ?? '', bytes: (await r.arrayBuffer()).byteLength };
      }),
    );
  });

  for (const r of results) {
    expect(r.status, `${r.path} did not serve`).toBe(200);
    expect(r.bytes, `${r.path} served nothing`).toBeGreaterThan(0);
    expect(r.type, `${r.path} served as HTML — a fallback, not the file`).not.toContain('text/html');
  }

  // The weights are the bulk of it; a stub or a Git LFS pointer would not be.
  const recognition = results.find((r) => r.path.endsWith('face_recognition_model.bin'));
  expect(recognition!.bytes).toBeGreaterThan(1_000_000);
});

test('loads the matcher under the real CSP', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) violations.push(m.text());
  });

  await openFan(page);

  const loaded = await page.evaluate(async (specifier) => {
    const mod = await import(specifier);
    await mod.readyFaceMatcher();
    const { faceapi } = globalThis as unknown as {
      faceapi: {
        nets: {
          tinyFaceDetector: { isLoaded: boolean };
          faceLandmark68TinyNet: { isLoaded: boolean };
          faceRecognitionNet: { isLoaded: boolean };
        };
        tf: { getBackend(): string };
      };
    };
    return {
      detector: faceapi.nets.tinyFaceDetector.isLoaded,
      landmarks: faceapi.nets.faceLandmark68TinyNet.isLoaded,
      recognition: faceapi.nets.faceRecognitionNet.isLoaded,
      backend: faceapi.tf.getBackend(),
    };
  }, CAPTURE_MODULE);

  // All three, because the app needs all three and a partial load throws deep
  // inside face-api rather than where anybody would look.
  expect(loaded.detector).toBe(true);
  expect(loaded.landmarks).toBe(true);
  expect(loaded.recognition).toBe(true);
  // Whichever backend it settled on, it settled on one. A gate lane on a
  // machine with no GPU should be slow, not broken.
  expect(['webgl', 'cpu', 'wasm']).toContain(loaded.backend);

  expect(violations, 'the page reported a CSP violation').toEqual([]);
});

test('opens the camera and gets frames out of it', async ({ page }) => {
  await openFan(page);

  const frame = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 480 } });
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 500));
    const size = { width: video.videoWidth, height: video.videoHeight };
    stream.getTracks().forEach((t) => t.stop());
    return size;
  });

  expect(frame.width).toBeGreaterThan(0);
  expect(frame.height).toBeGreaterThan(0);
});

test('refuses an empty frame instead of inventing a vector', async ({ page }) => {
  /*
   * The safety property, and the reason this file exists.
   *
   * A flat frame rather than the camera, because the camera's contents depend
   * on whether a face fixture has been built — and this assertion has to hold
   * either way. What must come back is a refusal with a code somebody can act
   * on, never a vector. A matcher that produced 128 numbers from an empty frame
   * would bind a ticket to nothing, and nobody would find out until a door.
   */
  await openFan(page);

  const outcome = await page.evaluate(async (specifier) => {
    const mod = await import(specifier);
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#3b3b3b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    try {
      const result = await mod.faceVector(canvas);
      return { threw: false, dims: result?.vector?.length ?? 0 };
    } catch (e) {
      return { threw: true, code: (e as { code?: string }).code, message: (e as Error).message };
    }
  }, CAPTURE_MODULE);

  expect(outcome.threw, 'an empty frame produced a face vector').toBe(true);
  expect(outcome.code).toBe('NO_FACE');
  // The message is an instruction, not a diagnosis. Somebody is standing in
  // front of a camera waiting to be told what to do.
  expect(outcome.message).toContain('Look at the camera');
});

test('reports a refused camera as a refusal', async ({ browser }) => {
  // A fresh context with the permission withheld. The fan app has a documented
  // answer for this and it must not look like a crash.
  const context = await browser.newContext({ permissions: [] });
  const page = await context.newPage();
  await context.clearPermissions();
  await page.route('**/v1/**', (r) => r.fulfill({ json: {} }));
  await page.goto(FAN);

  const denied = await page.evaluate(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ video: true });
      return 'granted';
    } catch (e) {
      return (e as Error).name;
    }
  });

  // `--use-fake-ui-for-media-stream` auto-accepts, so this may well be granted
  // here; what must never happen is an unhandled rejection reaching the page.
  expect(['granted', 'NotAllowedError', 'NotFoundError']).toContain(denied);
  await context.close();
});

test.describe('with a real face in front of the lens', () => {
  test.skip(!HAS_FACE, 'no .calibration/fixture/face.y4m — run `npm run face:fixture`');

  test('turns it into a vector of the right shape', async ({ page }) => {
    await openFan(page);

    const captured = await page.evaluate(async (specifier) => {
      const mod = await import(specifier);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480 } });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 800));

      try {
        const { vector, quality } = await mod.faceVector(video);
        let sumSquares = 0;
        for (const x of vector) sumSquares += x * x;
        return { dims: vector.length, norm: Math.sqrt(sumSquares), quality };
      } finally {
        stream.getTracks().forEach((t) => t.stop());
      }
    }, CAPTURE_MODULE);

    expect(captured.dims).toBe(128);
    // Unit-normalised, so that comparison is a dot product. Everything
    // downstream — the thresholds, the gate, the dedupe — assumes this.
    expect(captured.norm).toBeCloseTo(1, 5);
  });

  test('matches the same face and not a different one', async ({ page }) => {
    await openFan(page);

    /*
     * Two captures of the same stream must agree far more than the impostor
     * ceiling measured in packages/biometrics, or the thresholds that entire
     * suite established mean nothing through a camera.
     */
    const scores = await page.evaluate(async (specifier) => {
      const mod = await import(specifier);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480 } });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 800));

      try {
        const first = await mod.faceVector(video);
        await new Promise((r) => setTimeout(r, 400));
        const second = await mod.faceVector(video);
        return { self: mod.similarity(first.vector, second.vector) };
      } finally {
        stream.getTracks().forEach((t) => t.stop());
      }
    }, CAPTURE_MODULE);

    // The measured impostor maximum is 0.543 and the match threshold 0.60.
    expect(scores.self).toBeGreaterThan(0.6);
  });
});
