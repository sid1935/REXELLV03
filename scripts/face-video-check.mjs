/**
 * Does going through a camera cost the matcher anything?
 *
 *   npm run face:videocheck
 *
 * The size sweep draws each face onto a canvas and reads it back, and found no
 * degradation down to the smallest size it could capture: the worst genuine
 * pair stayed above 0.62 at every size, against a 0.60 match threshold.
 *
 * But an earlier measurement through the browser test fixture — the same faces,
 * at a similar size — put genuine pairs between 0.24 and 0.70. The two disagree,
 * and only one of them ran through what a fan actually uses: a camera, which
 * means YUV 4:2:0 chroma subsampling, a decoder, and a `<video>` element scaled
 * to whatever `getUserMedia` was asked for.
 *
 * So this runs the same photographs through that path. Every frame is the same
 * person, so every pair is genuine, and the statistic that collapsed before is
 * the one reported here. If the canvas and the camera agree, the earlier reading
 * was about framing. If they do not, the loss is in the pipeline — and that is a
 * different fact with a different fix, one no amount of raising MIN_FACE_PX
 * would address.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { staticServer } from '../packages/ui/static-server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const facesDir = resolve(root, '.calibration', 'faces');
const tmpDir = resolve(root, '.calibration', 'videocheck');
const outFile = resolve(root, '.calibration', 'video-check.json');
const PORT = 8179;

const FRAME_W = 640;
const FRAME_H = 480;
const FPS = 15;
const FRAMES_EACH = 10;
/** What the page asks getUserMedia for. The fan app asks for 480. */
const REQUEST_WIDTH = 480;
const SIZES = [112, 160, 240];
const PERSON = process.argv[2] ?? 'obama';

if (!existsSync(facesDir)) {
  console.error('\n  No calibration set. Run `npm run face:calibrate` first.\n');
  process.exit(1);
}

const photos = readdirSync(facesDir)
  .filter((f) => f.startsWith(`${PERSON}-`) && /\.jpe?g$/i.test(f))
  .sort()
  .map((f) => resolve(facesDir, f));

if (photos.length < 2) {
  console.error(`\n  Need at least two photographs of "${PERSON}".\n`);
  process.exit(1);
}

console.log(`\n  ${photos.length} photographs of ${PERSON}`);
console.log(`  sizes: ${SIZES.join(', ')}px face width, drawn into ${FRAME_W}x${FRAME_H}`);
console.log(`  the page asks getUserMedia for ${REQUEST_WIDTH}px wide\n`);

const server = staticServer({
  root: resolve(root, 'apps', 'fan', 'public'),
  ui: resolve(root, 'packages', 'ui'),
  port: PORT,
  apiOrigin: `http://127.0.0.1:${PORT}`,
  host: '127.0.0.1',
});

const clamp = (n) => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));

function toI420(rgba) {
  const y = new Uint8Array(FRAME_W * FRAME_H);
  const u = new Uint8Array((FRAME_W / 2) * (FRAME_H / 2));
  const v = new Uint8Array((FRAME_W / 2) * (FRAME_H / 2));
  for (let row = 0; row < FRAME_H; row += 1) {
    for (let col = 0; col < FRAME_W; col += 1) {
      const i = (row * FRAME_W + col) * 4;
      y[row * FRAME_W + col] = clamp(16 + (65.481 * rgba[i] + 128.553 * rgba[i + 1] + 24.966 * rgba[i + 2]) / 255);
    }
  }
  for (let row = 0; row < FRAME_H; row += 2) {
    for (let col = 0; col < FRAME_W; col += 2) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const i = ((row + dr) * FRAME_W + (col + dc)) * 4;
        r += rgba[i];
        g += rgba[i + 1];
        b += rgba[i + 2];
      }
      const at = (row / 2) * (FRAME_W / 2) + col / 2;
      u[at] = clamp(128 + (-37.797 * (r / 4) - 74.203 * (g / 4) + 112.0 * (b / 4)) / 255);
      v[at] = clamp(128 + (112.0 * (r / 4) - 93.786 * (g / 4) - 18.214 * (b / 4)) / 255);
    }
  }
  return Buffer.concat([Buffer.from(y), Buffer.from(u), Buffer.from(v)]);
}

/** Render every photograph at one face size, and report what the canvas sees. */
async function renderAt(page, size) {
  const frames = [];
  const canvasScores = [];
  const vectors = [];

  for (const photo of photos) {
    const dataUri = `data:image/jpeg;base64,${readFileSync(photo).toString('base64')}`;
    const got = await page.evaluate(
      async ([uri, w, h, target, specifier]) => {
        const mod = await import(specifier);
        await mod.readyFaceMatcher();
        const faceapi = globalThis.faceapi;

        const img = new Image();
        img.src = uri;
        await img.decode();

        const probe = document.createElement('canvas');
        probe.width = img.naturalWidth;
        probe.height = img.naturalHeight;
        probe.getContext('2d').drawImage(img, 0, 0);
        const found = await faceapi.detectAllFaces(
          probe,
          new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.55 }),
        );
        if (found.length !== 1) return { skipped: found.length === 0 ? 'NO_FACE' : 'MANY_FACES' };

        const box = found[0].box;
        const side = Math.max(box.width, box.height) * 1.9;
        const sx = box.x + box.width / 2 - side / 2;
        const sy = box.y + box.height / 2 - side / 2;
        const drawn = Math.round((target / box.width) * side);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#202020';
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, side, side, Math.round((w - drawn) / 2), Math.round((h - drawn) / 2), drawn, drawn);

        try {
          const { vector, quality } = await mod.faceVector(canvas);
          return { rgba: Array.from(ctx.getImageData(0, 0, w, h).data), vector, measured: quality.faceWidth };
        } catch (e) {
          return { skipped: e.code ?? e.message };
        }
      },
      [dataUri, FRAME_W, FRAME_H, size, '/face-capture.js'],
    );

    if (got.skipped) continue;
    frames.push(Uint8ClampedArray.from(got.rgba));
    vectors.push(got.vector);
    canvasScores.push(got.measured);
  }

  return { frames, vectors, measured: canvasScores };
}

const dot = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 1) n += a[i] * b[i];
  return n;
};
const pairs = (vs) => {
  const out = [];
  for (let i = 0; i < vs.length; i += 1) for (let j = i + 1; j < vs.length; j += 1) out.push(dot(vs[i], vs[j]));
  return out;
};
const stats = (xs) =>
  xs.length === 0
    ? null
    : {
        n: xs.length,
        min: +Math.min(...xs).toFixed(3),
        median: +[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(3),
        max: +Math.max(...xs).toFixed(3),
      };

mkdirSync(tmpDir, { recursive: true });
const results = [];

// One browser for the canvas renders; a fresh one per size for the camera,
// because the fake capture file is chosen at launch.
const renderBrowser = await chromium.launch();
const renderPage = await renderBrowser.newPage();
await renderPage.goto(`http://127.0.0.1:${PORT}/`);

for (const size of SIZES) {
  const { frames, vectors, measured } = await renderAt(renderPage, size);
  if (frames.length < 2) {
    console.log(`  ${String(size).padStart(3)}px  too few usable photographs`);
    continue;
  }

  const y4m = resolve(tmpDir, `face-${size}.y4m`);
  const parts = [Buffer.from(`YUV4MPEG2 W${FRAME_W} H${FRAME_H} F${FPS}:1 Ip A1:1 C420\n`)];
  for (const frame of frames) {
    const plane = toI420(frame);
    for (let i = 0; i < FRAMES_EACH; i += 1) parts.push(Buffer.from('FRAME\n'), plane);
  }
  writeFileSync(y4m, Buffer.concat(parts));

  const camBrowser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${y4m}`,
    ],
  });
  const camContext = await camBrowser.newContext({ permissions: ['camera'] });
  const camPage = await camContext.newPage();
  await camPage.goto(`http://127.0.0.1:${PORT}/`);

  const viaCamera = await camPage.evaluate(
    async ([requestWidth, samples, specifier]) => {
      const mod = await import(specifier);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: requestWidth } });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 700));

      const vectors = [];
      const widths = [];
      for (let i = 0; i < samples; i += 1) {
        try {
          const { vector, quality } = await mod.faceVector(video);
          vectors.push(vector);
          widths.push(quality.faceWidth);
        } catch {
          /* a frame in transition; the next one will do */
        }
        await new Promise((r) => setTimeout(r, 220));
      }
      const dims = { w: video.videoWidth, h: video.videoHeight };
      stream.getTracks().forEach((t) => t.stop());
      return { vectors, widths, dims };
    },
    [REQUEST_WIDTH, 12, '/face-capture.js'],
  );
  await camBrowser.close();

  const canvasStats = stats(pairs(vectors));
  const cameraStats = stats(pairs(viaCamera.vectors));
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

  results.push({
    size,
    canvas: { faceWidth: avg(measured), captures: vectors.length, genuine: canvasStats },
    camera: { faceWidth: avg(viaCamera.widths), captures: viaCamera.vectors.length, video: viaCamera.dims, genuine: cameraStats },
  });

  console.log(
    `  ${String(size).padStart(3)}px target — canvas face ${avg(measured)}px, camera face ${avg(viaCamera.widths)}px in ${viaCamera.dims.w}x${viaCamera.dims.h}`,
  );
}

await renderBrowser.close();
server.close?.();

const pad = (s, n) => String(s).padStart(n);
console.log('\n  Genuine pairs — the same person, every pair\n');
console.log('   target    canvas min   canvas med      camera min   camera med   captures');
console.log('   ' + '─'.repeat(72));
for (const r of results) {
  const c = r.canvas.genuine;
  const v = r.camera.genuine;
  console.log(
    `   ${pad(r.size, 5)}px  ${pad(c ? c.min.toFixed(3) : '—', 10)}   ${pad(c ? c.median.toFixed(3) : '—', 10)}   ${pad(v ? v.min.toFixed(3) : '—', 13)}   ${pad(v ? v.median.toFixed(3) : '—', 10)}   ${pad(r.camera.captures, 8)}`,
  );
}

console.log('\n  A camera costs the matcher the difference between those columns.');
console.log('  Anything below 0.60 would be refused at a gate as a non-match.\n');

writeFileSync(outFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), person: PERSON, requestWidth: REQUEST_WIDTH, results }, null, 2)}\n`);
console.log(`  wrote ${outFile}\n`);
