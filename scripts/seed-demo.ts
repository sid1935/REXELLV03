/**
 * Demo data.
 *
 *   npm start          # bring the stack up first
 *   npm run seed:demo  # then this
 *
 * ⚠ These events are built from public listings so the demo looks like a real
 * Saturday rather than a wall of "Test Event 1". They are illustrative only:
 * ReXell has no relationship with any of these events, venues or promoters, the
 * organizer accounts below are fictional, and no ticket here is real.
 *
 * Sources for the names, venues and dates are listed in docs/DEMO.md.
 *
 * The point of the spread is the resale column. Every event sets its dials
 * differently, because that is the product: a stadium that wants a tight cap, a
 * club that wants none, a festival that wants a market it takes a cut of.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const API = process.env['REXELL_API'] ?? 'http://127.0.0.1:8080';
const DIMS = 128;
const DAY = 86_400_000;
const HOUR = 3_600_000;

// ─── plumbing ────────────────────────────────────────────────────────────────

interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  key?: string,
  method?: string,
): Promise<Res<T>> {
  const res = await fetch(`${API}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

/** Deterministic synthetic faces — the same construction the tests use. */
const lcg = (seed: number) => {
  let s = (seed | 0) || 1;
  return () => ((s = (Math.imul(s, 1_103_515_245) + 12_345) & 0x7fffffff), s / 0x7fffffff);
};
function face(seed: number): number[] {
  const rand = lcg(Math.imul(seed, 2_654_435_761) + 1);
  const v = Array.from({ length: DIMS }, () => rand() * 2 - 1);
  const mag = Math.hypot(...v);
  return v.map((x) => x / mag);
}
function capture(base: number[], jitter = 0.15, seed = 7): number[] {
  const rand = lcg(Math.imul(seed, 48_271) + 11);
  const scale = (jitter / Math.sqrt(DIMS)) * Math.sqrt(3);
  const v = base.map((x) => x + (rand() * 2 - 1) * scale);
  const mag = Math.hypot(...v);
  return v.map((x) => x / mag);
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const now = Date.now();

// ─── the catalogue ───────────────────────────────────────────────────────────

interface TierSpec {
  key: string;
  name: string;
  rupees: number;
  allocation: number;
  /** null means bound: no resale at any price. */
  capPct: number | null;
  organizerPct?: number;
  artistPct?: number;
}

interface EventSpec {
  id: string;
  name: string;
  venue: string;
  /** Days from now that doors open. Negative means it is happening today. */
  inDays: number;
  capacity: number;
  maxPerPerson: number;
  organizer: 'festivals' | 'venues';
  tiers: TierSpec[];
  /** One line for the demo script, explaining why this event's dials are set this way. */
  why: string;
}

const CATALOGUE: readonly EventSpec[] = [
  {
    id: 'evt_lolla_2027',
    name: 'Lollapalooza India 2027',
    venue: 'Mahalaxmi Racecourse, Mumbai',
    inDays: 135,
    capacity: 60_000,
    maxPerPerson: 4,
    organizer: 'festivals',
    why: 'The big one. Resale on with a 110% cap, because a market they take 7% of beats a market they cannot see.',
    tiers: [
      { key: 'ga', name: 'General Admission — 2 Day', rupees: 12_500, allocation: 48_000, capPct: 110, organizerPct: 7, artistPct: 2 },
      { key: 'vip', name: 'VIP — 2 Day', rupees: 24_000, allocation: 6_000, capPct: 110, organizerPct: 7, artistPct: 2 },
    ],
  },
  {
    id: 'evt_gnr_blr',
    name: "Guns N' Roses — Bengaluru",
    venue: 'NICE Grounds, Bengaluru',
    inDays: 65,
    capacity: 45_000,
    maxPerPerson: 2,
    organizer: 'festivals',
    why: 'A scalper magnet, so a tight 105% cap and only two per person. Gold Circle is bound outright — the tier where fraud hurts most is the tier that cannot be resold.',
    tiers: [
      { key: 'ga', name: 'General Admission', rupees: 4_000, allocation: 34_000, capPct: 105, organizerPct: 10, artistPct: 3 },
      { key: 'gold', name: 'Gold Circle', rupees: 9_500, allocation: 4_000, capPct: null },
    ],
  },
  {
    id: 'evt_anyma_mum',
    name: 'Anyma — Mumbai',
    venue: 'Mahalaxmi Race Course, Mumbai',
    inDays: 72,
    capacity: 20_000,
    maxPerPerson: 4,
    organizer: 'festivals',
    why: 'A straightforward capped resale at 115%, with the artist taking a share of it.',
    tiers: [{ key: 'ga', name: 'General Admission', rupees: 3_500, allocation: 16_000, capPct: 115, organizerPct: 6, artistPct: 4 }],
  },
  {
    id: 'evt_nh7_pune',
    name: 'NH7 Weekender — Pune',
    venue: 'Mahalaxmi Lawns, Pune',
    inDays: 92,
    capacity: 25_000,
    maxPerPerson: 6,
    organizer: 'festivals',
    why: 'Six per person, because this one sells to groups of friends rather than to individuals.',
    tiers: [{ key: 'ga', name: 'Weekender Pass', rupees: 3_500, allocation: 20_000, capPct: 110, organizerPct: 7, artistPct: 2 }],
  },
  {
    id: 'evt_chetfaker_blr',
    name: 'Chet Faker — Bengaluru',
    venue: 'Phoenix Marketcity, Bengaluru',
    inDays: 24,
    capacity: 3_500,
    maxPerPerson: 2,
    organizer: 'venues',
    why: 'Resale off entirely. A 3,500-capacity room does not need a secondary market, it needs the people who bought to be the people who come.',
    tiers: [{ key: 'ga', name: 'Standing', rupees: 2_500, allocation: 3_000, capPct: null }],
  },
  {
    id: 'evt_bfc_home',
    name: 'Bengaluru FC vs Mohun Bagan',
    venue: 'Sree Kanteerava Stadium, Bengaluru',
    // Today. Doors already open, box office still selling — a real Saturday,
    // and the only way one snapshot shows a live sale AND a live gate.
    inDays: 0,
    capacity: 26_000,
    maxPerPerson: 4,
    organizer: 'venues',
    why: 'Happening tonight. Doors are open, the box office is still selling, and the gate is running — which is what makes it the one to demo.',
    tiers: [
      { key: 'ga', name: 'General Stand', rupees: 300, allocation: 18_000, capPct: 110, organizerPct: 8, artistPct: 0 },
      { key: 'west', name: 'West Stand', rupees: 1_200, allocation: 5_000, capPct: null },
    ],
  },
];

// ─── build ───────────────────────────────────────────────────────────────────

function eventPayload(spec: EventSpec) {
  const doors = spec.inDays === 0 ? now - 30 * 60_000 : now + spec.inDays * DAY;
  const ends = doors + (spec.inDays === 0 ? 8 * HOUR : 10 * HOUR);
  // A live event keeps the box office open; a future one closes two hours before.
  const salesClose = spec.inDays === 0 ? now + 4 * HOUR : doors - 2 * HOUR;

  return {
    id: spec.id,
    name: spec.name,
    capacity: spec.capacity,
    salesOpenAt: now - 7 * DAY,
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
              opensAt: now - 6 * DAY,
              closesAt: spec.inDays === 0 ? ends : doors - 6 * HOUR,
              // A real event holds a ticket for 24 hours before it can be
              // relisted, which defeats buy-and-flip bots. This demo compresses
              // a month of sales into ten seconds, so a cooldown would block
              // every resale below and the commercial story would not appear.
              // The dial itself is demonstrated in the console's create form,
              // where it defaults to 24 hours.
              cooldownMs: 0,
              maxResalesPerTicket: 2,
              maxActiveListingsPerIdentity: 2,
              splits: {
                organizerBps: (t.organizerPct ?? 7) * 100,
                platformBps: 300,
                rightsHolderBps: (t.artistPct ?? 0) * 100,
              },
            },
    })),
  };
}

interface Held {
  ticketId: string;
  eventId: string;
  tierId: string;
}

interface Fan {
  id: string;
  seed: number;
  /**
   * Which ticket is for which event.
   *
   * A flat list of ids is not enough: a fan holds tickets across the whole
   * catalogue, and pricing one event's ticket at another event's ceiling is how
   * this script spent its first run reporting resales it had not made.
   */
  tickets: Held[];
}

/**
 * The last reason an enrolment failed.
 *
 * This function used to return `undefined` for every failure and say nothing.
 * When rate limiting arrived, sixty enrolments failed in silence and the script
 * went on to print "Demo is ready" over an empty database. Whatever went wrong
 * is now kept and reported.
 */
let lastFanFailure = '';

const why = (label: string, res: { status: number; body: unknown }): undefined => {
  const code = (res.body as { error?: { code?: string; message?: string } })?.error;
  lastFanFailure = `${label} → ${res.status}${code?.code ? ` ${code.code}` : ''}${code?.message ? `: ${code.message}` : ''}`;
  return undefined;
};

async function makeFan(seed: number): Promise<Fan | undefined> {
  const created = await call<{ identityId: string }>('/v1/identities', {});
  if (created.status !== 201) return why('POST /v1/identities', created);
  const id = created.body.identityId;

  await call(`/v1/identities/${id}/consents`, { purposes: ['biometric_enrolment'] });
  const challenge = await call<{ id: string; nonce: string }>(`/v1/identities/${id}/enrolment/challenge`, {});
  if (challenge.status !== 201) return why('enrolment/challenge', challenge);

  const enrolled = await call(`/v1/identities/${id}/enrolment`, {
    scope: 'global',
    vector: capture(face(seed)),
    liveness: { challengeId: challenge.body.id, nonce: challenge.body.nonce, passiveScore: 0.97, actionCompleted: true },
  });
  if (enrolled.status !== 201) return why('enrolment', enrolled);

  return { id, seed, tickets: [] };
}

async function buy(fan: Fan, eventId: string, tierId: string, quantity: number): Promise<boolean> {
  const order = await call<{ orderId: string }>('/v1/orders', { identityId: fan.id, tierId, quantity });
  if (order.status !== 201) return false;
  const paid = await call<{ tickets: string[] }>(`/v1/orders/${order.body.orderId}/pay`, {});
  if (paid.status !== 201) return false;
  for (const ticketId of paid.body.tickets) fan.tickets.push({ ticketId, eventId, tierId });
  return true;
}

// ─── run ─────────────────────────────────────────────────────────────────────

console.log('\n  Seeding ReXell demo data…\n');

const health = await call<{ ok: boolean }>('/health').catch(() => undefined);
if (!health || health.status !== 200) {
  console.error(`  Cannot reach the API at ${API}. Run \`npm start\` first.\n`);
  process.exit(1);
}

/**
 * Refuse to run twice.
 *
 * Without this a second run creates two more organizers, fails every event with
 * "already exists", sells nothing, and reports a confident "Demo is ready" over
 * the top of a database that has not changed. A seed that lies about what it
 * did is worse than one that refuses.
 */
const existing = await call<{ total: number }>('/v1/discover?limit=1');
if ((existing.body.total ?? 0) > 0) {
  console.error('  This database already has events in it.\n');
  console.error('  Reseeding would create duplicate organizers and silently do nothing else.');
  console.error('  Stop the stack, delete .dev.sqlite* and .dev-vault.sqlite*, then start again.\n');
  process.exit(1);
}

const organizers: Record<string, { name: string; key: string; id: string }> = {};
for (const [slug, name] of [
  ['festivals', 'Meridian Festivals'],
  ['venues', 'Southside Venues'],
] as const) {
  const created = await call<{ apiKey: string; organizerId: string }>('/v1/organizers', {
    name,
    contactEmail: `ops@${slug}.example`,
  });
  organizers[slug] = { name, key: created.body.apiKey, id: created.body.organizerId };
  console.log(`  organizer  ${name.padEnd(20)} ${created.body.organizerId}`);
}

console.log('');
const created: EventSpec[] = [];
for (const spec of CATALOGUE) {
  const res = await call('/v1/organizer/events', { event: eventPayload(spec) }, organizers[spec.organizer]!.key);
  if (res.status !== 201) {
    console.log(`  ✕ ${spec.name} — ${(res.body as { error?: { message?: string } }).error?.message ?? res.status}`);
    continue;
  }
  created.push(spec);
  const modes = spec.tiers.map((t) => (t.capPct === null ? 'bound' : `${t.capPct}%`)).join(' / ');
  console.log(`  event      ${spec.name.padEnd(34)} ${modes}`);
}

// Fans. Enough to make the bands move and the graph interesting, few enough
// that this finishes while somebody is watching.
process.stdout.write('\n  enrolling fans ');
const fans: Fan[] = [];
for (let i = 0; i < 60; i += 1) {
  const fan = await makeFan(i);
  if (fan) fans.push(fan);
  if (i % 10 === 0) process.stdout.write('·');
}
console.log(` ${fans.length} enrolled`);

// Nothing below this line works without fans, and a seed that carries on to
// announce a ready demo over an empty database is worse than one that stops.
if (fans.length === 0) {
  console.error(`\n  Nobody could enrol, so there is nothing to sell.`);
  console.error(`  Last failure: ${lastFanFailure || 'no response recorded'}\n`);
  process.exit(1);
}
if (fans.length < 30) {
  console.error(`\n  Only ${fans.length} of 60 enrolled — the demo will look thin.`);
  console.error(`  Last failure: ${lastFanFailure}\n`);
}

// Sales, weighted so the availability bands differ across the catalogue.
const DEMAND: Record<string, number> = {
  evt_lolla_2027: 1.0,
  evt_gnr_blr: 1.0,
  evt_anyma_mum: 0.6,
  evt_nh7_pune: 0.45,
  evt_chetfaker_blr: 0.9,
  evt_bfc_home: 0.75,
};

let sold = 0;
for (const spec of created) {
  const share = DEMAND[spec.id] ?? 0.5;
  const buyers = fans.slice(0, Math.round(fans.length * share));
  for (const [i, fan] of buyers.entries()) {
    const tier = spec.tiers[i % spec.tiers.length]!;
    const quantity = Math.min(spec.maxPerPerson, 1 + (i % 2));
    if (await buy(fan, spec.id, `${spec.id}_${tier.key}`, quantity)) sold += quantity;
  }
}
console.log(`  ${sold} tickets sold across ${created.length} events`);

// Resales, on the capped tiers only.
await sleep(50);
let resold = 0;
const refusals = new Map<string, number>();
const perEvent = new Map<string, number>();
const resoldFor = (id: string) => perEvent.get(id) ?? 0;
const note = (code: string) => refusals.set(code, (refusals.get(code) ?? 0) + 1);

for (const spec of created) {
  const capped = spec.tiers.find((t) => t.capPct !== null);
  if (!capped) continue;
  const tierId = `${spec.id}_${capped.key}`;
  const ceiling = Math.floor(capped.rupees * 100 * (capped.capPct! / 100));
  const heldInTier = (f: Fan) => f.tickets.find((t) => t.tierId === tierId);

  for (const seller of fans.slice(0, 12)) {
    const held = heldInTier(seller);
    if (!held) continue;
    const buyer = fans.find(
      (f, j) => j > 40 && f.id !== seller.id && f.tickets.filter((t) => t.eventId === spec.id).length < spec.maxPerPerson,
    );
    if (!buyer) continue;
    if (resoldFor(spec.id) >= 4) break;

    const ticketId = held.ticketId;
    const listed = await call<{ listingId: string; error?: { code: string } }>('/v1/listings', {
      ticketId,
      identityId: seller.id,
      priceMinor: ceiling,
    });
    if (listed.status !== 201) {
      note(listed.body.error?.code ?? `list_${listed.status}`);
      continue;
    }

    const bought = await call<{ error?: { code: string } }>(`/v1/listings/${listed.body.listingId}/buy`, {
      buyerIdentityId: buyer.id,
      expectedPriceMinor: ceiling,
    });
    if (bought.status === 201) {
      resold += 1;
      perEvent.set(spec.id, resoldFor(spec.id) + 1);
      seller.tickets = seller.tickets.filter((t) => t.ticketId !== ticketId);
      buyer.tickets.push(held);
    } else {
      note(bought.body.error?.code ?? `buy_${bought.status}`);
    }
  }

  // Leave a couple listed, so the market is not empty when somebody looks.
  // Below the ceiling, because a real secondary market is not all at the cap.
  let openListings = 0;
  for (const seller of fans.slice(20, 40)) {
    if (openListings >= 2) break;
    const held = heldInTier(seller);
    if (!held) continue;
    const listed = await call<{ error?: { code: string } }>('/v1/listings', {
      ticketId: held.ticketId,
      identityId: seller.id,
      priceMinor: Math.max(Math.floor(capped.rupees * 100 * 0.6), Math.floor(ceiling * 0.94)),
    });
    if (listed.status === 201) openListings += 1;
    else note(listed.body.error?.code ?? `open_${listed.status}`);
  }
}
console.log(`  ${resold} resales settled at the ceiling`);
if (refusals.size > 0) {
  // Refusals are the system working, so they are reported rather than hidden.
  const summary = [...refusals.entries()].map(([code, n]) => `${code}×${n}`).join(', ');
  console.log(`  ${resold === 0 ? '✕ ' : ''}refused: ${summary}`);
}

// A signal graph, so the fraud console has a farm to find.
for (let i = 50; i < 58; i += 1) {
  const fan = fans[i];
  if (!fan) continue;
  await call('/v1/risk/signals', { identityId: fan.id, kind: 'device', value: `dev_worker_${i}` });
  await call('/v1/risk/signals', { identityId: fan.id, kind: 'card', value: 'card_operator_7741' });
}
const clustered = await call<{ suspicious: number; largest: number }>('/v1/risk/cluster', {});
console.log(`  ${clustered.body.suspicious} suspicious cluster of ${clustered.body.largest} accounts planted`);

// Tonight's gate.
const tonight = created.find((s) => s.inDays === 0);
let scans = 0;
if (tonight) {
  const key = organizers[tonight.organizer]!.key;
  const { generateDeviceKey, GateEngine, openManifest } = await import('@rexell/gate');
  const keys = generateDeviceKey();

  await call(
    '/v1/scanners',
    { scannerId: 'scn_demo_lane_1', eventId: tonight.id, lane: 'lane_1', gateGroup: 'main', publicKeyPem: keys.publicKeyPem },
    key,
  );
  const sealed = await call<{ sealed: never }>(`/v1/events/${tonight.id}/manifest/sealed`, { scannerId: 'scn_demo_lane_1' }, key);
  const released = await call<{ key: string }>(`/v1/events/${tonight.id}/manifest/key`, { scannerId: 'scn_demo_lane_1' }, key);

  if (released.status === 200) {
    const manifest = openManifest(sealed.body.sealed, Buffer.from(released.body.key, 'base64'), Date.now(), 'scn_demo_lane_1');
    const engine = new GateEngine(manifest, {
      scannerId: 'scn_demo_lane_1',
      lane: 'lane_1',
      gateGroup: 'main',
      privateKeyPem: keys.privateKeyPem,
      allowReentry: false,
    });
    // Two thirds of the crowd through the doors so far. A gate mid-flow reads
    // more honestly than one that is finished.
    for (const fan of fans.slice(0, Math.round(fans.length * 0.66))) {
      engine.scan(capture(face(fan.seed), 0.2, 900 + fan.seed) as never, Date.now());
      scans += 1;
    }
    await call(`/v1/events/${tonight.id}/attestations/signed`, { attestations: engine.pendingUploads() }, key);
  }
}
console.log(`  ${scans} scans uploaded from tonight's gate`);

await call('/v1/chain/drain', {});
console.log('  chain outbox drained\n');

// ─── what to do next ─────────────────────────────────────────────────────────

const line = '─'.repeat(66);
console.log(`  ${line}`);
console.log('  Demo is ready.\n');
console.log('    Fan app            http://127.0.0.1:8120');
console.log('    Organizer console  http://127.0.0.1:8110');
console.log('    Gate scanner       npm run scanner\n');
console.log('  Organizer keys — paste into the console, "I already have a key":\n');
for (const [slug, org] of Object.entries(organizers)) {
  const owned = CATALOGUE.filter((e) => e.organizer === slug).length;
  console.log(`    ${org.name.padEnd(20)} ${org.key}`);
  console.log(`    ${' '.repeat(20)} ${owned} events\n`);
}
console.log(`  Tonight's event for the gate:  ${tonight?.id ?? 'none'}`);
console.log(`  Total face value on sale:      ${rupees(
  CATALOGUE.reduce((sum, e) => sum + e.tiers.reduce((s, t) => s + t.rupees * 100 * t.allocation, 0), 0),
)}`);
console.log(`\n  Walkthrough: docs/DEMO.md`);
console.log(`  ${line}\n`);
console.log('  These events are illustrative, built from public listings. ReXell has');
console.log('  no relationship with them and no ticket here is real.\n');
