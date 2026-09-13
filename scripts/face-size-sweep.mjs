/**
 * How small can a face be before the matcher stops recognising it?
 *
 *   npm run face:calibrate     # once, to fetch the portraits
 *   npm run face:sweep         # this
 *
 * `MIN_FACE_PX` decides whether a capture is accepted at all, and it was set to
 * 96 without measurement. Building the browser test fixture suggested that was
 * far too permissive: two captures of the same person at about 110px scored
 * between 0.24 and 0.70 against a 0.60 match threshold, while the same pair at
 * 250px scored above 0.85. A capture that clears MIN_FACE_PX and then reliably
 * fails to match is worse than a refused one — the refusal says "move closer"
 * and costs five seconds; the acceptance costs somebody their enrolment and
 * surfaces at a door.
 *
 * So this measures it properly, the way the thresholds themselves were
 * measured: every photograph through the same browser matcher the fan app
 * enrols with, scored pairwise, at a range of sizes.
 *
 * Two questions, and they are different:
 *
 *   1. Same size against same size. Isolates the effect of scale — if both
 *      captures are small, do they still agree?
 *   2. Each size against a large reference. The realistic case, because a
 *      template enrolled once at a good size is compared against whatever the
 *      gate camera happens to get.
 *
 * The second is what MIN_FACE_PX should be set from. The number that matters is
 * not the average but the worst genuine pair, because a threshold that admits
 * the median and rejects the tail is a threshold that turns real ticket-holders
 * away — and the whole design of the review band exists to avoid exactly that.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { staticServer } from '../packages/ui/static-server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const facesDir = resolve(root, '.calibration', 'faces');
const outFile = resolve(root, '.calibration', 'size-sweep.json');
const PORT = 8178;

/** Frame size is fixed; the face inside it is what varies. */
const FRAME_W = 640;
const FRAME_H = 480;
/** Target face widths in pixels, spanning MIN_FACE_PX and well past it. */
const SIZES = [64, 80, 96, 112, 128, 160, 200, 240];
/** The reference every size is also compared against. */
const REFERENCE = 240;

const MATCH = 0.6;
const REVIEW = 0.5;

if (!existsSync(facesDir)) {
  console.error(`\n  No calibration set at ${facesDir}.`);
  console.error('  Run `npm run face:calibrate` first.\n');
  process.exit(1);
}

const photos = readdirSync(facesDir)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort()
  .map((f) => ({ person: f.split('-')[0], file: resolve(facesDir, f), name: f }));

const people = [...new Set(photos.map((p) => p.person))];
console.log(`\n  ${photos.length} photographs of ${people.length} people: ${people.join(', ')}`);
console.log(`  sizes: ${SIZES.join(', ')}px face width in a ${FRAME_W}x${FRAME_H} frame\n`);

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
await page.evaluate(async (specifier) => {
  const mod = await import(specifier);
  await mod.readyFaceMatcher();
}, '/face-capture.js');

/** person → size → [vector] */
const samples = [];
let refused = 0;

for (const photo of photos) {
  const dataUri = `data:image/jpeg;base64,${readFileSync(photo.file).toString('base64')}`;
  const got = await page.evaluate(
    async ([uri, frameW, frameH, sizes, specifier]) => {
      const mod = await import(specifier);
      const faceapi = globalThis.faceapi;

      const img = new Image();
      img.src = uri;
      await img.decode();

      // Find the head once, on the original.
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
      // The crop is a fixed multiple of the head, so the only thing changing
      // across sizes is resolution — not how much of the person is in frame.
      const margin = 1.9;
      const side = Math.max(box.width, box.height) * margin;
      const sx = box.x + box.width / 2 - side / 2;
      const sy = box.y + box.height / 2 - side / 2;

      const out = [];
      for (const target of sizes) {
        // Draw the head at `target` px wide, centred in the frame. The
        // downscale is what degrades the descriptor, which is the thing being
        // measured — so it happens once, here, exactly as a camera would.
        const drawn = Math.round((target / box.width) * side);
        const canvas = document.createElement('canvas');
        canvas.width = frameW;
        canvas.height = frameH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#202020';
        ctx.fillRect(0, 0, frameW, frameH);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, side, side, Math.round((frameW - drawn) / 2), Math.round((frameH - drawn) / 2), drawn, drawn);

        try {
          const { vector, quality } = await mod.faceVector(canvas);
          out.push({ target, vector, measured: quality.faceWidth, score: quality.detectionScore });
        } catch (e) {
          out.push({ target, refused: e.code ?? e.message });
        }
      }
      return { out };
    },
    [dataUri, FRAME_W, FRAME_H, SIZES, '/face-capture.js'],
  );

  if (got.skipped) {
    console.log(`  skipped ${photo.name} — ${got.skipped}`);
    continue;
  }
  for (const s of got.out) {
    if (s.refused) {
      refused += 1;
      continue;
    }
    samples.push({ person: photo.person, photo: photo.name, size: s.target, measured: s.measured, vector: s.vector });
  }
  const usable = got.out.filter((s) => !s.refused).length;
  console.log(`  ${photo.name.padEnd(14)} ${usable}/${SIZES.length} sizes usable`);
}

await browser.close();
server.close?.();

const dot = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 1) n += a[i] * b[i];
  return n;
};
const stats = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    min: +s[0].toFixed(4),
    p5: +s[Math.floor(s.length * 0.05)].toFixed(4),
    median: +s[Math.floor(s.length / 2)].toFixed(4),
    max: +s[s.length - 1].toFixed(4),
  };
};

const at = (size) => samples.filter((s) => s.size === size);
const reference = at(REFERENCE);

const rows = [];
for (const size of SIZES) {
  const here = at(size);

  // 1. Same size against same size, different photographs.
  const sameGenuine = [];
  const sameImpostor = [];
  for (let i = 0; i < here.length; i += 1) {
    for (let j = i + 1; j < here.length; j += 1) {
      if (here[i].photo === here[j].photo) continue;
      const score = dot(here[i].vector, here[j].vector);
      (here[i].person === here[j].person ? sameGenuine : sameImpostor).push(score);
    }
  }

  // 2. This size against a well-framed reference of the same person.
  const refGenuine = [];
  const refImpostor = [];
  for (const probe of here) {
    for (const ref of reference) {
      if (probe.photo === ref.photo) continue; // the same image at two sizes is not a pair
      const score = dot(probe.vector, ref.vector);
      (probe.person === ref.person ? refGenuine : refImpostor).push(score);
    }
  }

  rows.push({
    size,
    measured: here.length ? Math.round(here.reduce((n, s) => n + s.measured, 0) / here.length) : 0,
    captured: here.length,
    sameSize: { genuine: stats(sameGenuine), impostor: stats(sameImpostor) },
    againstReference: { genuine: stats(refGenuine), impostor: stats(refImpostor) },
  });
}

const pad = (s, n) => String(s).padStart(n);
console.log(`\n  Against a ${REFERENCE}px reference — the case that decides MIN_FACE_PX\n`);
console.log('   target  actual   n   genuine min  gen p5   gen med   impostor max   verdict');
console.log('   ' + '─'.repeat(76));
for (const r of rows) {
  const g = r.againstReference.genuine;
  const i = r.againstReference.impostor;
  if (!g || !i) {
    console.log(`   ${pad(r.size, 5)}px  ${pad(r.measured, 5)}   ${pad(r.captured, 3)}   (nothing captured)`);
    continue;
  }
  const verdict = g.min >= MATCH ? 'usable' : g.min >= REVIEW ? 'review band' : 'FAILS';
  console.log(
    `   ${pad(r.size, 5)}px  ${pad(r.measured, 5)}   ${pad(r.captured, 3)}   ${pad(g.min.toFixed(3), 10)}   ${pad(g.p5.toFixed(3), 6)}   ${pad(g.median.toFixed(3), 7)}   ${pad(i.max.toFixed(3), 12)}   ${verdict}`,
  );
}

console.log(`\n  Same size against same size — the effect of scale on both captures\n`);
console.log('   target    n   genuine min   gen med   impostor max');
console.log('   ' + '─'.repeat(56));
for (const r of rows) {
  const g = r.sameSize.genuine;
  const i = r.sameSize.impostor;
  if (!g || !i) continue;
  console.log(
    `   ${pad(r.size, 5)}px  ${pad(g.n, 3)}   ${pad(g.min.toFixed(3), 11)}   ${pad(g.median.toFixed(3), 7)}   ${pad(i.max.toFixed(3), 12)}`,
  );
}

const safe = rows.find((r) => r.againstReference.genuine && r.againstReference.genuine.min >= MATCH);
console.log('');
if (safe) {
  console.log(`  Smallest size whose worst genuine pair still clears ${MATCH}: ${safe.size}px`);
} else {
  console.log(`  No size tested kept every genuine pair above ${MATCH}.`);
}
if (refused > 0) console.log(`  ${refused} capture(s) refused by the matcher (below MIN_FACE_PX or undetected)`);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), frame: { width: FRAME_W, height: FRAME_H }, reference: REFERENCE, thresholds: { match: MATCH, review: REVIEW }, rows }, null, 2)}\n`);
console.log(`\n  wrote ${outFile}\n`);
