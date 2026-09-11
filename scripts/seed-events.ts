/**
 * Publish the event catalogue.
 *
 *   REXELL_API=https://rexell.duckdns.org \
 *   SIGNUP_INVITE_TOKEN=… \
 *   npm run seed:events
 *
 * Distinct from `seed:demo`, which also invents sixty fans, four hundred
 * tickets and a night at a gate. That belongs in a laptop database being shown
 * to somebody. This one publishes only the catalogue, so it is safe to point
 * at a deployment people actually use.
 *
 * ⚠ The events are real and the dates are taken from public listings. ReXell
 * has no relationship with any of these artists, venues or promoters, the two
 * organizer accounts are fictional, and the prices and allocations are
 * illustrative. Sources are in docs/DEMO.md.
 */

const API = (process.env['REXELL_API'] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const INVITE = process.env['SIGNUP_INVITE_TOKEN'] ?? '';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.now();

interface Res<T> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res<T>> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface TierSpec {
  key: string;
  name: string;
  rupees: number;
  allocation: number;
  /** null means the tier is soulbound — it cannot be resold at all. */
  capPct: number | null;
  organizerPct?: number;
  artistPct?: number;
}

interface EventSpec {
  id: string;
  name: string;
  venue: string;
  /** Calendar date of the doors, as published. `null` means it opens today. */
  on: string | null;
  capacity: number;
  maxPerPerson: number;
  organizer: 'festivals' | 'venues';
  tiers: TierSpec[];
}

/*
 * Dates are from public listings for the six months from September 2026.
 *
 * `cooldownMs` is zero throughout rather than the day this would normally be.
 * A cooldown exists to stop a bot flipping inventory within seconds of an
 * onsale, and it is the right default — but it also makes it impossible to
 * walk a ticket from purchase to resale in one sitting, which is exactly what
 * anybody evaluating this needs to do. Worth stating rather than hiding.
 */
const CATALOGUE: readonly EventSpec[] = [
  {
    id: 'evt_gnr_blr_2026',
    name: "Guns N' Roses",
    venue: 'NICE Grounds, Bengaluru',
    on: '2026-11-14',
    capacity: 45_000,
    maxPerPerson: 2,
    organizer: 'festivals',
    tiers: [
      { key: 'ga', name: 'General Admission', rupees: 4_000, allocation: 34_000, capPct: 105, organizerPct: 10, artistPct: 3 },
      { key: 'gold', name: 'Gold Circle', rupees: 9_500, allocation: 4_000, capPct: null },
    ],
  },
  {
    id: 'evt_gnr_ghy_2026',
    name: "Guns N' Roses",
    venue: 'Khanapara Ground, Guwahati',
    on: '2026-11-17',
    capacity: 30_000,
    maxPerPerson: 4,
    organizer: 'festivals',
    tiers: [
      { key: 'ga', name: 'General Admission', rupees: 2_000, allocation: 26_000, capPct: 110, organizerPct: 8, artistPct: 2 },
    ],
  },
  {
    id: 'evt_anyma_mum_2026',
    name: 'Anyma presents AEDEN',
    venue: 'Mahalaxmi Race Course, Mumbai',
    on: '2026-11-21',
    capacity: 20_000,
    maxPerPerson: 4,
    organizer: 'festivals',
    tiers: [
      { key: 'ga', name: 'General Admission', rupees: 3_500, allocation: 15_000, capPct: 115, organizerPct: 6, artistPct: 4 },
      { key: 'vip', name: 'VIP', rupees: 11_000, allocation: 1_800, capPct: 115, organizerPct: 6, artistPct: 4 },
    ],
  },
  {
    id: 'evt_indianocean_blr_2026',
    name: 'Indian Ocean',
    venue: 'Phoenix Marketcity, Bengaluru',
    on: '2026-11-28',
    capacity: 3_500,
    maxPerPerson: 6,
    organizer: 'venues',
    // A room this size does not need a secondary market.
    tiers: [{ key: 'ga', name: 'Standing', rupees: 1_800, allocation: 3_200, capPct: null }],
  },
  {
    id: 'evt_fredagain_mum_2026',
    name: 'Fred again..',
    venue: 'Mahalaxmi Race Course, Mumbai',
    on: '2026-12-08',
    capacity: 25_000,
    maxPerPerson: 4,
    organizer: 'festivals',
    tiers: [
      { key: 'ga', name: 'Standard GA', rupees: 3_500, allocation: 19_000, capPct: 110, organizerPct: 7, artistPct: 3 },
      { key: 'gaplus', name: 'GA+', rupees: 6_000, allocation: 3_500, capPct: 110, organizerPct: 7, artistPct: 3 },
    ],
  },
  {
    id: 'evt_chainsmokers_blr_2026',
    name: 'Sunburn Arena ft. The Chainsmokers',
    venue: 'Embassy International Riding School, Bengaluru',
    on: '2026-12-20',
    capacity: 18_000,
    maxPerPerson: 4,
    organizer: 'festivals',
    tiers: [
      { key: 'ga', name: 'General Admission', rupees: 2_999, allocation: 14_000, capPct: 110, organizerPct: 8, artistPct: 2 },
      { key: 'fanpit', name: 'Fan Pit', rupees: 6_500, allocation: 2_000, capPct: null },
    ],
  },
  {
    id: 'evt_gorillaz_blr_2027',
    name: 'Gorillaz — The Mountain India Tour',
    venue: 'Bengaluru LIVE, Bengaluru',
    on: '2027-01-23',
    capacity: 32_000,
    maxPerPerson: 4,
    organizer: 'festivals',
    tiers: [
      { key: 'ga', name: 'General Admission', rupees: 4_500, allocation: 26_000, capPct: 110, organizerPct: 7, artistPct: 4 },
    ],
  },
  {
    id: 'evt_foofighters_mum_2027',
    name: 'Foo Fighters',
    venue: 'Mahalaxmi Race Course, Mumbai',
    on: '2027-01-31',
    capacity: 40_000,
    maxPerPerson: 4,
    organizer: 'festivals',
    tiers: [
      { key: 'ga', name: 'General Admission', rupees: 5_500, allocation: 32_000, capPct: 110, organizerPct: 7, artistPct: 3 },
      { key: 'gold', name: 'Gold Circle', rupees: 12_000, allocation: 3_000, capPct: null },
    ],
  },
  {
    id: 'evt_lolla_mum_2027',
    name: 'Lollapalooza India 2027',
    venue: 'Mahalaxmi Racecourse, Mumbai',
    on: '2027-01-24',
    capacity: 60_000,
    maxPerPerson: 4,
    organizer: 'festivals',
    tiers: [
      { key: 'ga', name: 'General Admission — 2 Day', rupees: 12_500, allocation: 48_000, capPct: 110, organizerPct: 7, artistPct: 2 },
      { key: 'vip', name: 'VIP — 2 Day', rupees: 24_000, allocation: 6_000, capPct: 110, organizerPct: 7, artistPct: 2 },
    ],
  },
  {
    /*
     * Doors already open.
     *
     * Every other event here is months away, and a manifest key does not
     * release until two hours before doors — so without one live event the
     * gate cannot be tried at all, and "buy a ticket and walk in" stops at
     * the buying. This is the one to scan against.
     */
    id: 'evt_tonight_blr',
    name: 'ReXell Live — Gate Demo Night',
    venue: 'Sree Kanteerava Stadium, Bengaluru',
    on: null,
    capacity: 8_000,
    maxPerPerson: 4,
    organizer: 'venues',
    tiers: [
      { key: 'ga', name: 'General Stand', rupees: 300, allocation: 6_500, capPct: 110, organizerPct: 6, artistPct: 0 },
      { key: 'west', name: 'West Stand', rupees: 900, allocation: 1_200, capPct: null },
    ],
  },
];

function eventPayload(spec: EventSpec) {
  const doors = spec.on === null ? now - 30 * MINUTE : Date.parse(`${spec.on}T19:00:00+05:30`);
  const live = spec.on === null;
  const ends = doors + (live ? 8 * HOUR : 6 * HOUR);
  // A live event keeps the box office open; a future one closes before doors.
  const salesClose = live ? now + 6 * HOUR : doors - 2 * HOUR;

  return {
    id: spec.id,
    name: spec.name,
    capacity: spec.capacity,
    salesOpenAt: now - DAY,
    salesCloseAt: salesClose,
    doorsOpenAt: doors,
    endsAt: ends,
    maxTicketsPerIdentity: spec.maxPerPerson,
    allowReentry: false,
    tiers: spec.tiers.map((t) => ({
      id: `${spec.id}_${t.key}`,
      eventId: spec.id,
      name: t.name,
      faceValue: t.rupees * 100,
      allocation: t.allocation,
      resale:
        t.capPct === null
          ? {
              mode: 'bound' as const,
              maxPriceBps: 10_000,
              minPriceBps: 10_000,
              opensAt: now,
              closesAt: doors,
              cooldownMs: 0,
              maxResalesPerTicket: 0,
              maxActiveListingsPerIdentity: 0,
              splits: { organizerBps: 0, platformBps: 0, rightsHolderBps: 0 },
            }
          : {
              mode: 'capped' as const,
              maxPriceBps: t.capPct * 100,
              minPriceBps: 5_000,
              opensAt: now - HOUR,
              closesAt: live ? ends : doors - 2 * HOUR,
              // Zero, so a ticket can be bought and resold in one sitting.
              cooldownMs: 0,
              maxResalesPerTicket: 3,
              maxActiveListingsPerIdentity: 2,
              splits: {
                organizerBps: (t.organizerPct ?? 0) * 100,
                platformBps: 150,
                rightsHolderBps: (t.artistPct ?? 0) * 100,
              },
            },
    })),
  };
}

// ─── run ─────────────────────────────────────────────────────────────────────

console.log(`\n  Publishing the catalogue to ${API}\n`);

const health = await call<{ ok: boolean }>('/health').catch(() => undefined);
if (!health || health.status !== 200) {
  console.error(`  Cannot reach the API at ${API}.\n`);
  process.exit(1);
}

const existing = await call<{ total: number }>('/v1/discover?limit=1');
if ((existing.body.total ?? 0) > 0) {
  console.error(`  This deployment already lists ${existing.body.total} event(s).`);
  console.error('  Refusing to add more on top — remove them first, or point this at a clean database.\n');
  process.exit(1);
}

const headers = INVITE ? { 'x-signup-token': INVITE } : {};
const organizers: Record<string, string> = {};

for (const [slug, name] of [
  ['festivals', 'Meridian Festivals'],
  ['venues', 'Southside Venues'],
] as const) {
  const res = await call<{ apiKey: string; organizerId: string; error?: { message: string } }>(
    '/v1/organizers',
    { name },
    headers,
  );
  if (res.status !== 201) {
    console.error(`  Could not create ${name}: ${res.status} ${res.body.error?.message ?? ''}`);
    if (res.status === 403) console.error('  Set SIGNUP_INVITE_TOKEN — this deployment is invitation-only.\n');
    process.exit(1);
  }
  organizers[slug] = res.body.apiKey;
  console.log(`  organizer  ${name.padEnd(20)} ${res.body.organizerId}`);
}

console.log('');
let made = 0;
for (const spec of CATALOGUE) {
  const key = organizers[spec.organizer]!;
  const res = await call<{ error?: { message: string } }>(
    '/v1/organizer/events',
    { event: eventPayload(spec) },
    { authorization: `Bearer ${key}` },
  );
  if (res.status !== 201) {
    console.log(`  ✕ ${spec.name} — ${res.body.error?.message ?? res.status}`);
    continue;
  }
  made += 1;
  const when = spec.on === null ? 'doors open now' : new Date(`${spec.on}T19:00:00+05:30`).toDateString();
  console.log(`  event      ${spec.name.padEnd(36)} ${when}`);
}

console.log(`\n  ${made} of ${CATALOGUE.length} events published.\n`);
console.log('  Organizer keys — paste into the console under "I already have a key":\n');
for (const [slug, key] of Object.entries(organizers)) {
  console.log(`    ${slug.padEnd(11)} ${key}`);
}
console.log('\n  These events are real and their dates come from public listings.');
console.log('  ReXell has no relationship with them; the organizers are fictional');
console.log('  and the prices and allocations are illustrative.\n');
