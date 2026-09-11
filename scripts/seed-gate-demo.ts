/**
 * An event whose doors are open, so a gate lane can actually be opened.
 *
 *   REXELL_API=https://rexell.duckdns.org npm run seed:gate
 *
 * Why this is a separate command rather than part of the catalogue.
 *
 * A manifest key is refused until two hours before doors — that is the whole
 * point of releasing it separately from the sealed blob, so a scanner stolen a
 * week out carries nothing openable. Every event in the catalogue is months
 * away, so every one of them refuses the key with TOO_EARLY, and the gate app
 * cannot be demonstrated at all. This creates one event that started half an
 * hour ago, which is the only way to see a lane work today.
 *
 * It is deliberately NOT in `catalogue.ts`. An event with doors open sits at the
 * top of Discover looking like the main attraction, which is why the last one
 * was removed. This one is opt-in, named for what it is, and can be removed
 * again with `npm run remove:event -- <id>`.
 */
import { randomBytes } from 'node:crypto';

const API = process.env['REXELL_API'] ?? 'http://127.0.0.1:8080';
const INVITE = process.env['SIGNUP_INVITE_TOKEN'] ?? '';
const HOUR = 3_600_000;
const MINUTE = 60_000;

const now = Date.now();
const id = `evt_gate_demo_${randomBytes(3).toString('hex')}`;

async function call<T>(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

console.log(`\n  ${API}\n`);

const org = await call<{ apiKey: string; organizerId: string; error?: { message: string } }>(
  '/v1/organizers',
  { name: 'ReXell Gate Demo' },
  INVITE ? { 'x-signup-token': INVITE } : {},
);
if (org.status !== 201) {
  console.error(`  Could not create the organizer: ${org.status} ${org.body.error?.message ?? ''}`);
  if (org.status === 403) console.error('  Set SIGNUP_INVITE_TOKEN — this deployment is invitation-only.\n');
  process.exit(1);
}
console.log(`  organizer   ${org.body.organizerId}`);

const doors = now - 30 * MINUTE;
const event = await call<{ error?: { message: string } }>(
  '/v1/organizer/events',
  {
    event: {
      id,
      name: 'Gate Test — Doors Open',
      venue: 'Lane A, anywhere',
      capacity: 200,
      salesOpenAt: now - HOUR,
      // The box office stays open, because the point is to buy a ticket and
      // walk straight to the door with it.
      salesCloseAt: now + 6 * HOUR,
      doorsOpenAt: doors,
      endsAt: doors + 8 * HOUR,
      maxTicketsPerIdentity: 2,
      allowReentry: false,
      tiers: [
        {
          id: `${id}_ga`,
          eventId: id,
          name: 'General Admission',
          faceValue: 50_000,
          allocation: 200,
          resale: {
            mode: 'capped',
            maxPriceBps: 11_000,
            minPriceBps: 5_000,
            opensAt: now - HOUR,
            closesAt: doors + 8 * HOUR,
            // Zero, so a ticket can be bought, resold and walked to the door in
            // one sitting — which is the entire point of this event existing.
            cooldownMs: 0,
            maxResalesPerTicket: 3,
            maxActiveListingsPerIdentity: 2,
            splits: { organizerBps: 1_000, platformBps: 150, rightsHolderBps: 0 },
          },
        },
      ],
    },
  },
  { 'x-api-key': org.body.apiKey },
);

if (event.status !== 201) {
  console.error(`\n  Could not create the event: ${event.status} ${event.body.error?.message ?? ''}\n`);
  process.exit(1);
}

console.log(`  event       ${id}`);
console.log(`  doors       ${new Date(doors).toLocaleString()}  (open)`);
console.log(`  key window  open now — it releases two hours before doors\n`);

/*
 * A lane, ready to open.
 *
 * The organizer console builds this same link on its Live tab, but reaching it
 * needs an API key, and the only thing standing between somebody and testing
 * the gate should be a camera. `PUBLIC_HOST` is where the browser will look;
 * it defaults to the API origin, which is right for the single-host deployment
 * and wrong for a laptop running four ports, hence the override.
 */
const host = process.env['PUBLIC_HOST'] ?? API;
const lane = {
  apiBase: host,
  eventId: id,
  scannerId: `scn_${randomBytes(3).toString('hex')}`,
  lane: 'Lane A',
  gateGroup: '',
  allowReentry: false,
  liveness: 'challenge',
};
const url = `${host}/gate/?config=${encodeURIComponent(Buffer.from(JSON.stringify(lane)).toString('base64'))}`;

console.log('  Open a lane with this link — it registers the device, pulls the');
console.log('  sealed manifest and asks for the key:\n');
console.log(`  ${url}\n`);
console.log('  ⚠ Buy the ticket FIRST. The manifest is sealed when the lane is');
console.log('  provisioned, so a ticket bought afterwards is not in it — reload');
console.log('  the link to pick it up.\n');
console.log(`  To remove it all:  npm run remove:event -- ${id} --force\n`);
