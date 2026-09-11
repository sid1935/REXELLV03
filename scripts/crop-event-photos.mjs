import { readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from "node:url";
const sharp = (await import(pathToFileURL(process.argv[2]).href)).default;
const dir = resolve(process.cwd(), 'packages/ui/events');

let done = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith('.src'))) {
  const id = f.replace(/\.src$/, '');
  const out = resolve(dir, `${id}.jpg`);
  // 1200x675 covers a card at 2x on a phone and the sheet on a laptop; cover
  // rather than contain, because a letterboxed concert photo looks like a
  // mistake. attention: entropy keeps the subject rather than the centre.
  await sharp(resolve(dir, f))
    .resize(1200, 675, { fit: 'cover', position: sharp.strategy.attention })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(out);
  rmSync(resolve(dir, f));
  console.log(`  ${id.padEnd(28)} ${(statSync(out).size / 1024).toFixed(0)} KiB`);
  done += 1;
}
console.log(`\n  ${done} cropped to 1200x675`);
