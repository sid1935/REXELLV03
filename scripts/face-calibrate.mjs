/**
 * Measure the face matcher, so the thresholds are a reading rather than a guess.
 *
 *   npm run face:calibrate
 *
 * Downloads several photographs of each of a handful of people from Wikimedia
 * Commons, serves them alongside the real `/face-capture.js` and the real
 * weights, and opens a page that scores every pair. Two distributions come out
 * of it: GENUINE, two photographs of the same person, and IMPOSTOR, two
 * photographs of different people. The gap between them is where the thresholds
 * belong.
 *
 * Why it exists at all. The three numbers in `packages/biometrics/thresholds.ts`
 * were set against a synthetic matcher — a function that recognised nobody — so
 * they described nothing. Carrying them over to a real network unexamined would
 * have been the worst of both worlds: numbers that look calibrated, chosen for a
 * model that no longer runs.
 *
 * ⚠ What this is NOT. Twenty photographs of five people is not a ROC curve, and
 * the people are public figures photographed by professionals in good light —
 * an easier population than a queue at a venue at night. It is enough to place
 * the thresholds sensibly and to prove the two distributions separate at all.
 * Before a real event the numbers have to be re-measured on the population and
 * the cameras that will actually be used, at the operating point the roadmap
 * specifies: FRR under 1.5% and FAR under 1 in 100,000.
 *
 * The photographs are Creative Commons or public domain, downloaded into a
 * gitignored directory and never committed. They are other people's faces; they
 * are test fixtures for one afternoon, not a dataset we keep.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.calibration');
const uiDir = resolve(root, 'packages/ui');

/**
 * Pinned by exact file title, for the same reason the event photographs are:
 * a search that quietly returned a different picture next month would change
 * the measurement without changing the code, and the thresholds would drift
 * with no commit to blame.
 *
 * Four photographs each, deliberately from different years, events and
 * photographers. Two crops of one original would score near 1.0 and would make
 * the matcher look far better than it is.
 */
const PEOPLE = {
  obama: [
    'File:Official portrait of Barack Obama.jpg',
    'File:Obama Portrait 2006.jpg',
    'File:President Barack Obama.jpg',
    "File:Barack Obama with artistic gymnastic McKayla Maroney 2.jpg",
  ],
  merkel: [
    'File:Angela Merkel IMG 4162 edit.jpg',
    'File:Angela Merkel. Tallinn Digital Summit.jpg',
    'File:Angela Merkel Uni Leibzig (2008).jpg',
    'File:Angela Merkel Juli 2010 - 3zu4.jpg',
  ],
  ardern: [
    'File:NZ PM Jacinda Ardern - Kirk HargreavesCCC.jpg',
    'File:New Zealand Prime Minister Jacinda Ardern in 2018.jpg',
    'File:Jacinda Ardern in Dunedin.jpg',
    'File:Jacinda Ardern - Waitangi 2022 (cropped).jpg',
  ],
  watson: [
    'File:Emma Watson 2013.jpg',
    'File:Emma Watson interview in 2017.jpg',
    'File:Emma Watson (5930414886).jpg',
    'File:Emma Watson GoF Premiere 2.jpg',
  ],
  messi: [
    'File:Lionel Messi in 2018.jpg',
    'File:Lionel Messi 2025.jpg',
    'File:Lionel-Messi-Argentina-2022-FIFA-World-Cup (cropped).jpg',
    'File:Suisse vs Argentine - Granit Xhaka & Lionel Messi.jpg',
  ],
};

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'ReXell/1.0 (matcher calibration; contact@rexell.tech)';
const PORT = Number(process.env.PORT ?? 8150);

async function download(person, index, title) {
  const file = resolve(outDir, 'faces', `${person}-${index}.jpg`);
  if (existsSync(file)) return true;
  const url =
    `${API}?action=query&format=json&titles=${encodeURIComponent(title)}` +
    `&prop=imageinfo&iiprop=url&iiurlwidth=900`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) {
    console.log(`  x ${person}-${index}: Commons answered ${res.status}`);
    return false;
  }
  const payload = await res.json();
  const page = Object.values(payload.query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  if (!info) {
    console.log(`  x ${person}-${index}: no such file — ${title}`);
    return false;
  }
  const image = await fetch(info.thumburl ?? info.url, { headers: { 'user-agent': UA } });
  if (!image.ok) {
    console.log(`  x ${person}-${index}: download failed (${image.status})`);
    return false;
  }
  writeFileSync(file, Buffer.from(await image.arrayBuffer()));
  console.log(`  ${person}-${index}  ${title}`);
  return true;
}

mkdirSync(resolve(outDir, 'faces'), { recursive: true });

console.log('\n  Fetching calibration photographs from Wikimedia Commons\n');
const manifest = [];
for (const [person, titles] of Object.entries(PEOPLE)) {
  for (const [i, title] of titles.entries()) {
    if (await download(person, i, title)) manifest.push({ person, file: `faces/${person}-${i}.jpg`, title });
  }
}
writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n  ${manifest.length} photographs of ${Object.keys(PEOPLE).length} people\n`);

/*
 * Serve the fixtures next to the real module and the real weights.
 *
 * The measurement has to run through exactly the code the fan app and the gate
 * run — the same detector options, the same landmark alignment, the same
 * normalisation. A separate Node-side reimplementation would be measuring a
 * different thing, and the difference is precisely where a calibration error
 * would hide.
 */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.bin': 'application/octet-stream',
};

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  /*
   * The page posts its descriptors back and they become a test fixture.
   *
   * 128 numbers per photograph, and nothing that can be turned back into a
   * face — which is the difference between committing this and committing the
   * photographs. It means the test suite can assert that the gate admits the
   * right person and refuses a stranger using output from the real network,
   * on a machine with no browser, no camera and no 8 MB of weights.
   */
  if (req.method === 'POST' && path === '/fixture') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const target = resolve(root, 'packages/biometrics/test/real-faces.json');
      writeFileSync(target, `${JSON.stringify(JSON.parse(Buffer.concat(chunks).toString()), null, 2)}\n`);
      console.log(`  wrote ${target}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    return;
  }
  const from =
    path === '/face-capture.js' || path.startsWith('/face/')
      ? resolve(uiDir, path.replace(/^\//, ''))
      : path === '/'
        ? resolve(root, 'scripts/face-calibrate.html')
        : path === '/fixture.html'
          ? resolve(root, 'scripts/face-fixture.html')
        : resolve(outDir, path.replace(/^\//, ''));
  if (!from.startsWith(uiDir) && !from.startsWith(outDir) && !from.startsWith(resolve(root, 'scripts'))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = readFileSync(from);
    res.writeHead(200, { 'content-type': TYPES[extname(from)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`  Open http://127.0.0.1:${PORT}/ and let it run.`);
  console.log(`  Then http://127.0.0.1:${PORT}/fixture.html to refresh the test fixture.`);
  console.log(`  ${readdirSync(resolve(outDir, 'faces')).length} files in .calibration/faces\n`);
});
