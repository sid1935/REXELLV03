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
import { CATALOGUE } from './catalogue.js';
import type { EventSpec } from './catalogue.js';

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


function eventPayload(spec: EventSpec) {
  const doors = spec.on === null ? now - 30 * MINUTE : Date.parse(`${spec.on}T19:00:00+05:30`);
  const live = spec.on === null;
  const ends = doors + (live ? 8 * HOUR : 6 * HOUR);
  // A live event keeps the box office open; a future one closes before doors.
  const salesClose = live ? now + 6 * HOUR : doors - 2 * HOUR;

  return {
    id: spec.id,
    name: spec.name,
    venue: spec.venue,
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
