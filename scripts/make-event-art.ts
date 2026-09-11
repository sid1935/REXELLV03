/**
 * Draw a poster for every event in the catalogue.
 *
 *   npm run art:events
 *
 * Writes `packages/ui/events/<event-id>.svg`, which the discover cards load
 * from `/events/<id>.svg`.
 *
 * ⚠ Why these are drawn rather than photographed.
 *
 * The obvious way to give each event a picture is to take the promoter's press
 * shot. Those are copyrighted, ReXell has no relationship with any of these
 * events, and hotlinking them would also break the moment the other site moved
 * a file. So each poster is generated instead: distinct per event, recognisably
 * ReXell, and nobody else's property.
 *
 * The path is the interface. Drop a licensed photograph at the same name and
 * the card picks it up with no code change — the generated art is a stand-in
 * that looks deliberate, not a placeholder that looks like one.
 *
 * Everything here is deterministic: the same event id always produces the same
 * poster, so a rebuild never reshuffles the catalogue's appearance.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOGUE } from './catalogue.js';
import type { EventSpec } from './catalogue.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'packages/ui/events');

const W = 800;
const H = 450;

/** FNV-1a. Small, stable, and good enough to scatter a dozen ids. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Two hues per event, spread evenly across the brand's range.
 *
 * 172° to 296° is cyan through blue to violet — the span the logo's own
 * gradient covers. Hashing the id and sampling anywhere in that span was the
 * first attempt and it failed visibly: the hashes clustered, every poster came
 * out violet, and ten events looked like one event ten times.
 *
 * So position in the catalogue picks the hue instead. It guarantees the set is
 * distinguishable, which is the whole job here — the cost is that inserting an
 * event shifts the ones after it, and since the art is regenerated with the
 * catalogue anyway, that costs nothing real.
 */
function palette(index: number, total: number): { a: string; b: string; accent: string } {
  const base = 172 + Math.round((index / Math.max(total - 1, 1)) * 124);
  const spread = 30;
  const a = `hsl(${base} 92% 58%)`;
  const b = `hsl(${Math.min(base + spread, 300)} 76% 50%)`;
  const accent = `hsl(${base} 100% 74%)`;
  return { a, b, accent };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** The city, which is the part of a venue string worth showing large. */
function city(venue: string): string {
  const parts = venue.split(',').map((p) => p.trim());
  return (parts.at(-1) ?? venue).toUpperCase();
}

function poster(spec: EventSpec, index: number, total: number): string {
  // The hash still drives the hexagon scatter, so each event keeps its own
  // arrangement no matter where it sits in the list.
  const seed = hash(spec.id);
  const { a, b, accent } = palette(index, total);
  const angle = 100 + (seed % 60);

  // A scatter of hexagons, placed from the same seed so each event gets its
  // own arrangement and keeps it.
  let rng = seed || 1;
  const next = () => ((rng = (Math.imul(rng, 48271) >>> 0) % 0x7fffffff) / 0x7fffffff);
  const hexes = Array.from({ length: 9 }, () => {
    const r = 46 + next() * 96;
    return {
      x: Math.round(next() * W),
      y: Math.round(next() * H),
      r: Math.round(r),
      o: (0.05 + next() * 0.1).toFixed(3),
      w: (1.5 + next() * 2).toFixed(1),
    };
  });

  const hexPath = (x: number, y: number, r: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const t = (Math.PI / 180) * (60 * i - 30);
      return `${(x + r * Math.cos(t)).toFixed(1)},${(y + r * Math.sin(t)).toFixed(1)}`;
    }).join(' ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.name)}">
  <title>${esc(spec.name)} — ${esc(spec.venue)}</title>
  <defs>
    <linearGradient id="g" x1="0" y1="${H}" x2="${W}" y2="0" gradientUnits="userSpaceOnUse"
                    gradientTransform="rotate(${angle - 120} ${W / 2} ${H / 2})">
      <stop offset="0" stop-color="${a}"/>
      <stop offset="1" stop-color="${b}"/>
    </linearGradient>
    <radialGradient id="glow" cx="${(0.12 + ((index * 0.17) % 0.7)).toFixed(2)}" cy="${(0.1 + ((index * 0.23) % 0.5)).toFixed(2)}" r="0.85">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0.35" stop-color="#020526" stop-opacity="0"/>
      <stop offset="1" stop-color="#020526" stop-opacity="0.72"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <g fill="none" stroke="#ffffff">
${hexes.map((h) => `    <polygon points="${hexPath(h.x, h.y, h.r)}" stroke-opacity="${h.o}" stroke-width="${h.w}"/>`).join('\n')}
  </g>
  <!-- Darkened towards the bottom, because the card prints the event's name
       and date directly beneath and the two should not compete. -->
  <rect width="${W}" height="${H}" fill="url(#shade)"/>
  <text x="40" y="${H - 38}" fill="#ffffff" fill-opacity="0.92"
        font-family="Archivo, 'Helvetica Neue', Arial, sans-serif"
        font-size="30" font-weight="800" letter-spacing="6">${esc(city(spec.venue))}</text>
</svg>
`;
}

mkdirSync(outDir, { recursive: true });

console.log(`\n  Drawing ${CATALOGUE.length} posters into packages/ui/events\n`);
for (const [index, spec] of CATALOGUE.entries()) {
  const file = resolve(outDir, `${spec.id}.svg`);
  writeFileSync(file, poster(spec, index, CATALOGUE.length));
  console.log(`  ${spec.id.padEnd(30)} ${city(spec.venue)}`);
}
console.log(`\n  Replace any of these with a licensed photograph at the same name`);
console.log(`  and the cards pick it up with no code change.\n`);
