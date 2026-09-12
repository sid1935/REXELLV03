/**
 * Build a webcam out of photographs.
 *
 *   npm run face:calibrate     # once, to fetch the portraits
 *   npm run face:fixture       # this, to turn them into a camera
 *
 * Chromium will play a Y4M file as the webcam given
 * `--use-file-for-fake-video-capture`, which is the only way to put a real face
 * in front of the real matcher — models, detector, descriptor and all — in a
 * browser nobody is sitting at.
 *
 * The output is deliberately not committed, and neither are its inputs. The
 * calibration portraits are Wikimedia Commons photographs of named people, and
 * a public repository is no place for somebody's face, still less for the
 * biometric template derivable from it. `.calibration/` is gitignored for that
 * reason and this writes inside it. The tests that need a face skip without it
 * and say so; everything else about the camera needs no likeness.
 *
 * Decoding is done by Chromium rather than by a JPEG library, because Playwright
 * is already a dependency and an image codec would be one more thing to keep.
 * The conversion to I420 afterwards is arithmetic and belongs here.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { staticServer } from '../packages/ui/static-server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const facesDir = resolve(root, '.calibration', 'faces');
const outDir = resolve(root, '.calibration', 'fixture');
const out = resolve(outDir, 'face.y4m');

const WIDTH = 640;
const HEIGHT = 480;
const FPS = 15;
/** How long each photograph stays on screen. Long enough that a capture lands squarely on one. */
const FRAMES_EACH = 8;

const who = process.argv[2] ?? 'obama';

if (!existsSync(facesDir)) {
  console.error(`\n  No calibration set at ${facesDir}.`);
  console.error('  Run `npm run face:calibrate` first — it fetches the portraits.\n');
  process.exit(1);
}

const photos = readdirSync(facesDir)
  .filter((f) => f.startsWith(`${who}-`) && /\.jpe?g$/i.test(f))
  .sort()
  .map((f) => resolve(facesDir, f));

if (photos.length === 0) {
  const available = [...new Set(readdirSync(facesDir).map((f) => f.split('-')[0]))].join(', ');
  console.error(`\n  No photographs for "${who}". Available: ${available}\n`);
  process.exit(1);
}

console.log(`\n  ${photos.length} photograph(s) of ${who}`);

const PORT = 8177;
/*
 * The real module decides what counts as usable, not this script.
 *
 * Two of the portraits in a calibration set turned out to have a second person
 * in the background, and `faceVector` refused them — correctly, because
 * enrolling with two faces in frame binds a ticket to whichever the detector
 * ranked first and nobody finds out until a door. A fixture built from those
 * frames makes the browser test fail for a reason that has nothing to do with
 * the browser, so the same guard runs here and drops them.
 */
const server = staticServer({
  root: resolve(root, 'apps', 'fan', 'public'),
  ui: resolve(root, 'packages', 'ui'),
  port: PORT,
  apiOrigin: `http://127.0.0.1:${PORT}`,
  host: '127.0.0.1',
});

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`);

const frames = [];
for (const photo of photos) {
  const name = basename(photo);
  const dataUri = `data:image/jpeg;base64,${readFileSync(photo).toString('base64')}`;
  const result = await page.evaluate(
    async ([uri, w, h]) => {
      const img = new Image();
      img.src = uri;
      await img.decode();

      const draw = (canvas, sx, sy, sw, sh) => {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#202020';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / sw, canvas.height / sh);
        const dw = Math.round(sw * scale);
        const dh = Math.round(sh * scale);
        ctx.drawImage(img, sx, sy, sw, sh, Math.round((canvas.width - dw) / 2), Math.round((canvas.height - dh) / 2), dw, dh);
        return ctx;
      };

      const first = document.createElement('canvas');
      first.width = w;
      first.height = h;
      draw(first, 0, 0, img.naturalWidth, img.naturalHeight);

      const mod = await import('/face-capture.js');
      await mod.readyFaceMatcher();
      const faceapi = globalThis.faceapi;

      const detected = await faceapi.detectAllFaces(first, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.55 }));
      if (detected.length !== 1) return { ok: false, reason: detected.length === 0 ? 'NO_FACE' : 'MANY_FACES' };

      /*
       * Cropped to the head, not letterboxed to the photograph.
       *
       * A whole portrait scaled into 640x480 leaves a face about 110px across,
       * which clears MIN_FACE_PX and produces a descriptor that does not
       * reliably match another capture of the same person — measured at 0.24 to
       * 0.70 against a 0.60 threshold. Enrolment does not look like that. It
       * looks like somebody holding a phone at arm's length, and the fixture
       * should too.
       */
      const box = detected[0].box;
      const margin = 1.9;
      const side = Math.max(box.width, box.height) * margin;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      // Back to source coordinates: the detection was made on the letterboxed
      // canvas, so undo that transform before cropping the original.
      const fit = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      const offX = (w - img.naturalWidth * fit) / 2;
      const offY = (h - img.naturalHeight * fit) / 2;
      const sx = (cx - side / 2 - offX) / fit;
      const sy = (cy - side / 2 - offY) / fit;
      const sSide = side / fit;

      const framed = document.createElement('canvas');
      framed.width = w;
      framed.height = h;
      const ctx = draw(framed, sx, sy, sSide, sSide);

      let quality;
      try {
        quality = (await mod.faceVector(framed)).quality;
      } catch (e) {
        return { ok: false, reason: e.code ?? e.message };
      }
      return { ok: true, quality, rgba: Array.from(ctx.getImageData(0, 0, w, h).data) };
    },
    [dataUri, WIDTH, HEIGHT],
  );

  if (!result.ok) {
    console.log(`    skipped  ${name} — ${result.reason}`);
    continue;
  }
  frames.push(Uint8ClampedArray.from(result.rgba));
  console.log(`    usable   ${name} — face ${result.quality.faceWidth}px, ${Math.round(result.quality.coverage * 100)}% of frame`);
}
await browser.close();
server.close?.();

if (frames.length === 0) {
  console.error('\n  Not one photograph held exactly one detectable face.\n');
  process.exit(1);
}

/**
 * RGB to I420, BT.601 limited range — what a webcam actually hands over.
 *
 * Chroma is averaged over each 2x2 block rather than point-sampled, which is
 * what the subsampling means and what stops fine detail turning into colour
 * fringing the detector has to see past.
 */
function toI420(rgba) {
  const y = new Uint8Array(WIDTH * HEIGHT);
  const u = new Uint8Array((WIDTH / 2) * (HEIGHT / 2));
  const v = new Uint8Array((WIDTH / 2) * (HEIGHT / 2));

  const clamp = (n) => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));

  for (let row = 0; row < HEIGHT; row += 1) {
    for (let col = 0; col < WIDTH; col += 1) {
      const i = (row * WIDTH + col) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      y[row * WIDTH + col] = clamp(16 + (65.481 * r + 128.553 * g + 24.966 * b) / 255);
    }
  }

  for (let row = 0; row < HEIGHT; row += 2) {
    for (let col = 0; col < WIDTH; col += 2) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const i = ((row + dr) * WIDTH + (col + dc)) * 4;
        r += rgba[i];
        g += rgba[i + 1];
        b += rgba[i + 2];
      }
      r /= 4;
      g /= 4;
      b /= 4;
      const at = (row / 2) * (WIDTH / 2) + col / 2;
      u[at] = clamp(128 + (-37.797 * r - 74.203 * g + 112.0 * b) / 255);
      v[at] = clamp(128 + (112.0 * r - 93.786 * g - 18.214 * b) / 255);
    }
  }

  return Buffer.concat([Buffer.from(y), Buffer.from(u), Buffer.from(v)]);
}

const planes = frames.map(toI420);

const parts = [Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F${FPS}:1 Ip A1:1 C420\n`)];
for (const plane of planes) {
  for (let i = 0; i < FRAMES_EACH; i += 1) {
    parts.push(Buffer.from('FRAME\n'), plane);
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(out, Buffer.concat(parts));

const seconds = ((planes.length * FRAMES_EACH) / FPS).toFixed(1);
console.log(`\n  wrote ${out}`);
console.log(`  ${WIDTH}x${HEIGHT}, ${planes.length * FRAMES_EACH} frames, ${seconds}s, looped by Chromium\n`);
console.log('  `npm run test:browser` will now run the face tests instead of skipping them.\n');
