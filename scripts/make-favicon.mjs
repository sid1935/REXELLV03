/**
 * Cut the mark out of the official lockup and build the icon set.
 *
 *   npm run art:favicon
 *
 * The lockup is 400x145 — a wide wordmark. At 16 pixels that is an illegible
 * smear, so the favicon is the hexagon from the left of it, which is the part
 * of the logo that survives being tiny. Columns 0-118 are the mark; a 31-column
 * gap separates it from the word.
 *
 * Two variants, because they are asked for by different things:
 *
 *   icon.png        transparent, square, for the browser tab
 *   icon-touch.png  on the brand navy, for iOS — a transparent home-screen
 *                   icon is composited onto black there and loses the mark's
 *                   own dark edges
 */
import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
const sharp = (await import(pathToFileURL(process.argv[2]).href)).default;

const src = 'packages/ui/logo-lockup.png';
const out = 'packages/ui';

// The mark, trimmed to its own bounds then padded back to a square so it is
// centred rather than stretched.
const mark = await sharp(src)
  .extract({ left: 0, top: 0, width: 119, height: 145 })
  .trim({ threshold: 6 })
  .toBuffer();

// One resize per pipeline is all sharp honours — a second silently loses to
// the first — so the padding is computed to land on the size rather than
// resized into it afterwards.
const square = (size, background, flatten = false) => {
  const inner = Math.round(size * 0.82);
  const pad = Math.round((size - inner) / 2);
  const edge = size - inner - pad;
  let pipe = sharp(mark)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: pad, bottom: edge, left: pad, right: edge, background });
  if (flatten) pipe = pipe.flatten({ background });
  // Palette-quantised: a browser tab icon does not need 24-bit colour, and an
  // uncompressed 512px gradient is a third of a megabyte for sixteen pixels of
  // visible result.
  return pipe.png({ compressionLevel: 9, palette: true, quality: 90 });
};

await square(512, { r: 0, g: 0, b: 0, alpha: 0 }).toFile(resolve(out, 'icon.png'));
// #020526 is --paper in the app's dark theme, so the touch icon sits on the
// same ground the app opens on.
await square(180, { r: 2, g: 5, b: 38, alpha: 1 }, true).toFile(resolve(out, 'icon-touch.png'));

for (const f of ['icon.png', 'icon-touch.png']) {
  const m = await sharp(resolve(out, f)).metadata();
  console.log(`  ${f.padEnd(16)} ${m.width}x${m.height}  alpha ${m.hasAlpha}  ${(statSync(resolve(out, f)).size / 1024).toFixed(1)} KiB`);
}
