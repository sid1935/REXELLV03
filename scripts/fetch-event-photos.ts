/**
 * Fetch a real photograph for each event, from Wikimedia Commons.
 *
 *   npm run art:photos
 *
 * Writes `packages/ui/events/<event-id>.jpg` and records what it took and
 * from whom in `packages/ui/events/credits.json`.
 *
 * ⚠ Why Commons rather than the promoter's press shot.
 *
 * The press shots are copyrighted and ReXell has no relationship with any of
 * these events, so putting them on a site that appears to sell their tickets
 * is an exposure. Commons carries real photographs of the same artists under
 * licences that permit exactly this, on one condition: the photographer is
 * credited. That condition is the reason credits.json exists and the reason
 * the event sheet prints a credit line — an unattributed CC BY image is a
 * licence breach, not a tidier page.
 *
 * Where no properly licensed photograph of an act exists, that event keeps its
 * generated poster. A photograph of somebody else, captioned as this act,
 * would be worse than an abstract.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE } from './catalogue.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'packages/ui/events');

/**
 * The exact Commons file for each event.
 *
 * Pinned by title rather than resolved by search at build time: a search that
 * silently returns a different photograph next month would put the wrong band
 * on the card, and nothing would look broken.
 */
const PHOTOS: Record<string, string> = {
  evt_gnr_blr_2026: 'File:GunsNRoses160617-61 (35271773841).jpg',
  evt_gnr_ghy_2026: "File:Guns N' Roses concert in Porto Alegre in 2022.jpg",
  evt_anyma_mum_2026: 'File:Anyma Afterlife Printworks.jpg',
  evt_indianocean_blr_2026: 'File:Indian Ocean at the Indo German Urban Mela.jpg',
  evt_gorillaz_blr_2027: 'File:Gorillaz, Brixton Academy, London (34342295764).jpg',
  evt_foofighters_mum_2027: 'File:Foo Fighters Molson Amphitheatre 8-7-2015.jpg',
  evt_lolla_mum_2027: 'File:Lollapalooza 2015.JPG',
  evt_tonight_blr: 'File:Sree Kanteerava Stadium.jpg',
  // Two events keep their generated poster.
  //
  // Commons has no photograph of Fred again.. at all. It does have one of The
  // Chainsmokers, but it is a forces' welfare photo-op in a warehouse beside a
  // tank — accurate, and nothing like a concert, so on a ticket card it reads
  // as the wrong picture. The nearest alternatives are other DJs entirely,
  // which would be worse: a card is a claim about who is playing.
};

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'ReXell/1.0 (event artwork; contact@rexell.tech)';

const strip = (html: string | undefined) =>
  (html ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

interface Credit {
  event: string;
  title: string;
  author: string;
  licence: string;
  licenceUrl: string;
  source: string;
}

async function fetchOne(eventId: string, title: string): Promise<Credit | undefined> {
  const url =
    `${API}?action=query&format=json&titles=${encodeURIComponent(title)}` +
    `&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1600`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) {
    console.log(`  ✕ ${eventId}: Commons answered ${res.status}`);
    return undefined;
  }
  const payload = (await res.json()) as { query?: { pages?: Record<string, unknown> } };
  const pages = payload.query?.pages ?? {};
  const page = Object.values(pages)[0] as
    | { imageinfo?: Array<{ thumburl?: string; url: string; descriptionurl: string; extmetadata?: Record<string, { value: string }> }> }
    | undefined;
  const info = page?.imageinfo?.[0];
  if (!info) {
    console.log(`  ✕ ${eventId}: no such file`);
    return undefined;
  }

  const meta = info.extmetadata ?? {};
  const licence = strip(meta.LicenseShortName?.value) || 'see source';
  const author = strip(meta.Artist?.value) || 'unknown';

  const image = await fetch(info.thumburl ?? info.url, { headers: { 'user-agent': UA } });
  if (!image.ok) {
    console.log(`  ✕ ${eventId}: download failed (${image.status})`);
    return undefined;
  }
  const bytes = Buffer.from(await image.arrayBuffer());
  writeFileSync(resolve(outDir, `${eventId}.src`), bytes);

  console.log(`  ${eventId.padEnd(28)} ${licence.padEnd(14)} ${author.slice(0, 34)}`);
  return {
    event: eventId,
    title: title.replace(/^File:/, ''),
    author,
    licence,
    licenceUrl: strip(meta.LicenseUrl?.value),
    source: info.descriptionurl,
  };
}

mkdirSync(outDir, { recursive: true });

console.log(`\n  Fetching ${Object.keys(PHOTOS).length} photographs from Wikimedia Commons\n`);

const credits: Credit[] = [];
for (const [eventId, title] of Object.entries(PHOTOS)) {
  const credit = await fetchOne(eventId, title);
  if (credit) credits.push(credit);
}

writeFileSync(resolve(outDir, 'credits.json'), `${JSON.stringify(credits, null, 2)}\n`);

const without = CATALOGUE.filter((e) => !credits.some((c) => c.event === e.id));
console.log(`\n  ${credits.length} photographs, credited in packages/ui/events/credits.json`);
if (without.length) {
  console.log(`  ${without.length} keeping generated art: ${without.map((e) => e.name).join(', ')}`);
}
console.log(`\n  Run "npm run art:crop" to turn the downloads into 16:9 cards.\n`);
if (!existsSync(resolve(outDir, 'credits.json'))) process.exit(1);
