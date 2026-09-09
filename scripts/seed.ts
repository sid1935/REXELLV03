/**
 * Seed a realistic event and drive one of everything through it.
 *
 * This is the 12,000-capacity festival from the business plan, at the same face
 * values, so the settlement numbers this prints can be checked against the
 * worked example in `docs/business-plan.html` §05.
 *
 *   npm run seed
 */
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { DAY, HOUR, epochMs, formatMinor } from '@rexell/domain';
import type { EpochMs } from '@rexell/domain';
import { buildApp } from '../apps/api/src/app.js';
import { httpVaultClient } from '../apps/api/src/vault-client.js';
import { buildVault } from '../apps/vault/src/app.js';
import { capture, face } from '../apps/vault/test/helpers.js';

const DB_PATH = process.env['REXELL_DB'] ?? 'rexell.sqlite';
rmSync(DB_PATH, { force: true });
rmSync(`${DB_PATH}-wal`, { force: true });
rmSync(`${DB_PATH}-shm`, { force: true });

const T0 = Date.now();
const DOORS = T0 + 30 * DAY;
let clock = T0;
const now = (): EpochMs => epochMs(clock);

// The vault runs as its own service, on its own port, with its own keys. The API
// reaches it over HTTP — the same boundary as production, not a function call.
const vault = buildVault({
  location: ':memory:',
  masterKey: randomBytes(32),
  receiptKey: randomBytes(32),
  serviceToken: 'seed-token',
  now: () => clock,
});
await vault.server.listen({ port: 0, host: '127.0.0.1' });
const vaultUrl = `http://127.0.0.1:${vault.server.addresses()[0]?.port}`;

// Note: no devMode. Every fan below enrols for real — consent, challenge, vault.
const app = buildApp({ location: DB_PATH, now, vault: httpVaultClient(vaultUrl, 'seed-token') });
await app.server.ready();

const post = (url: string, payload: unknown) => app.server.inject({ method: 'POST', url, payload: payload as object });
const get = (url: string) => app.server.inject({ method: 'GET', url });

const rupees = (n: number) => formatMinor(n as never, { symbol: '₹' });

// ─── the event ───────────────────────────────────────────────────────────────

const EVENT = 'evt_sunburn26';
const event = {
  id: EVENT,
  organizerId: 'org_pinewood',
  name: 'Sunburn Weekender 2026',
  capacity: 12_000,
  salesOpenAt: T0,
  salesCloseAt: DOORS - 2 * HOUR,
  doorsOpenAt: DOORS,
  endsAt: DOORS + 10 * HOUR,
  maxTicketsPerIdentity: 4,
  allowReentry: false,
  tiers: [
    {
      id: 'tier_ga',
      eventId: EVENT,
      name: 'General Admission',
      faceValue: 220_000, // ₹2,200.00
      allocation: 11_200,
      resale: {
        mode: 'capped',
        maxPriceBps: 11_000, // 110% ceiling
        minPriceBps: 5_000,
        opensAt: T0 + 1 * DAY,
        closesAt: DOORS - 6 * HOUR,
        cooldownMs: 24 * HOUR,
        maxResalesPerTicket: 2,
        maxActiveListingsPerIdentity: 2,
        splits: { organizerBps: 700, platformBps: 300, rightsHolderBps: 200 },
      },
    },
    {
      id: 'tier_vip',
      eventId: EVENT,
      name: 'VIP',
      faceValue: 850_000, // ₹8,500.00
      allocation: 800,
      // Bound. The tier where fraud hurts most is the tier that cannot be resold.
      resale: {
        mode: 'bound',
        maxPriceBps: 10_000,
        minPriceBps: 10_000,
        opensAt: T0,
        closesAt: DOORS,
        cooldownMs: 0,
        maxResalesPerTicket: 0,
        maxActiveListingsPerIdentity: 0,
        splits: { organizerBps: 0, platformBps: 0, rightsHolderBps: 0 },
      },
    },
  ],
};

const created = await post('/v1/events', { event, organizerName: 'Pinewood Live' });
if (created.statusCode !== 201) throw new Error(`event creation failed: ${created.body}`);
console.log(`\n  ${event.name}`);
console.log(`  policy hash  ${created.json().policyHash.slice(0, 32)}…`);
console.log(`  capacity     ${event.capacity.toLocaleString('en-IN')}  ·  GA ${rupees(220_000)}  ·  VIP ${rupees(850_000)}\n`);

// ─── fans ────────────────────────────────────────────────────────────────────

/** Consent, challenge, capture, enrol — the real path, for every fan. */
async function enrolFan(identityId: string, faceVector: ReturnType<typeof face>, jitter = 0.2) {
  await post(`/v1/identities/${identityId}/consents`, { purposes: ['biometric_enrolment'] });
  const challenge = (await post(`/v1/identities/${identityId}/enrolment/challenge`, {})).json();
  return post(`/v1/identities/${identityId}/enrolment`, {
    scope: 'global',
    vector: [...capture(faceVector, jitter)],
    liveness: { challengeId: challenge.id, nonce: challenge.nonce, passiveScore: 0.96, actionCompleted: true },
  });
}

const FANS = 40;
const fans: string[] = [];
let flagged = 0;
for (let i = 0; i < FANS; i += 1) {
  const id = (await post('/v1/identities', { ageYears: 19 + (i % 30) })).json().identityId;
  // Fans 30 and 31 are the same person on two accounts — a scalper farming
  // identities to beat the per-identity purchase cap.
  const who = i === 31 ? face(30) : face(i);
  const enrolled = await enrolFan(id, who, i === 31 ? 0.18 : 0.2);
  if (enrolled.json().dedupe?.status === 'review') flagged += 1;
  fans.push(id);
}

// One fan who gave consent but never completed the capture.
const unenrolled = (await post('/v1/identities', {})).json().identityId;

// And one who tried to skip the camera entirely by POSTing a template.
const forged = (await post('/v1/identities', {})).json().identityId;
await post(`/v1/identities/${forged}/consents`, { purposes: ['biometric_enrolment'] });
const replay = await post(`/v1/identities/${forged}/enrolment`, {
  scope: 'global',
  vector: [...capture(face(1))],
  liveness: { challengeId: 'chl_invented', nonce: 'made-up', passiveScore: 1, actionCompleted: true },
});

console.log(`  ${FANS} fans enrolled through the vault, ${flagged} flagged for review`);
console.log(`  template POSTed without a challenge: ${replay.statusCode} ${replay.json().error?.code}`);
console.log(`  bundled consent form: ${(await post(`/v1/identities/${unenrolled}/consents`, { purposes: ['terms_of_service', 'biometric_enrolment'] })).json().error?.code}`);

// ─── primary sales ───────────────────────────────────────────────────────────

const tickets = new Map<string, string[]>();
let sold = 0;
for (const [i, fan] of fans.entries()) {
  const tierId = i % 8 === 0 ? 'tier_vip' : 'tier_ga';
  const quantity = 1 + (i % 3);
  const order = await post('/v1/orders', { identityId: fan, tierId, quantity });
  if (order.statusCode !== 201) continue;
  const paid = await post(`/v1/orders/${order.json().orderId}/pay`, { authRef: `auth_seed_${i}` });
  if (paid.statusCode !== 201) continue;
  tickets.set(fan, paid.json().tickets);
  sold += quantity;
}

const blocked = await post('/v1/orders', { identityId: unenrolled, tierId: 'tier_ga', quantity: 1 });
console.log(`  ${sold} tickets sold`);
console.log(`  unenrolled fan refused: ${blocked.statusCode} ${blocked.json().error.code}`);

// ─── resale ──────────────────────────────────────────────────────────────────

// Move past the 24h cooldown so listings are allowed.
clock = T0 + 2 * DAY;

let listed = 0;
let resold = 0;
const sellers = [...tickets.entries()].filter(([, t]) => t.length > 0).slice(0, 12);

for (const [seller, owned] of sellers) {
  const ticketId = owned[0];
  if (!ticketId) continue;
  const r = await post('/v1/listings', { ticketId, identityId: seller, priceMinor: 242_000 });
  if (r.statusCode !== 201) continue;
  listed += 1;

  // A different fan buys it, if they have headroom under the per-event limit.
  const buyer = fans.find((f) => f !== seller && (tickets.get(f)?.length ?? 0) < 3);
  if (!buyer) continue;
  const bought = await post(`/v1/listings/${r.json().listingId}/buy`, {
    buyerIdentityId: buyer,
    expectedPriceMinor: 242_000,
  });
  if (bought.statusCode === 201) {
    resold += 1;
    tickets.set(buyer, [...(tickets.get(buyer) ?? []), ticketId]);
    tickets.set(seller, owned.slice(1));
  }
}

console.log(`\n  ${listed} listed at the ₹2,420.00 ceiling, ${resold} resold`);

// Two refusals worth seeing: a GA ticket priced above the ceiling, and any
// attempt at all on a bound VIP ticket.
const gaHolder = [...tickets.entries()].find(
  ([, owned]) => owned.length > 0 && app.repo.getTicket(owned[0] ?? '')?.tierId === 'tier_ga',
);
if (gaHolder) {
  const over = await post('/v1/listings', {
    ticketId: gaHolder[1][0],
    identityId: gaHolder[0],
    priceMinor: 600_000,
  });
  console.log(`  scalper at ${rupees(600_000)} on GA refused: ${over.statusCode} ${over.json().error?.code}`);
}

const vipHolder = [...tickets.entries()].find(
  ([, owned]) => owned.length > 0 && app.repo.getTicket(owned[0] ?? '')?.tierId === 'tier_vip',
);
if (vipHolder) {
  const bound = await post('/v1/listings', {
    ticketId: vipHolder[1][0],
    identityId: vipHolder[0],
    priceMinor: 850_000,
  });
  console.log(`  VIP resale at face value refused: ${bound.statusCode} ${bound.json().error?.code}`);
}

const settlement = (await get(`/v1/events/${EVENT}/settlement`)).json();
console.log(`\n  settlement`);
console.log(`    resale volume   ${rupees(settlement.resaleVolumeMinor)}`);
console.log(`    organizer 7%    ${rupees(settlement.organizerMinor)}`);
console.log(`    platform 3%     ${rupees(settlement.platformMinor)}`);
console.log(`    rights 2%       ${rupees(settlement.rightsHolderMinor)}`);
console.log(`    sellers 88%     ${rupees(settlement.sellerMinor)}`);

const balances =
  settlement.organizerMinor + settlement.platformMinor + settlement.rightsHolderMinor + settlement.sellerMinor ===
  settlement.resaleVolumeMinor;
console.log(`    balances        ${balances ? 'yes, to the paisa' : 'NO — investigate'}`);

// ─── the gate ────────────────────────────────────────────────────────────────

clock = DOORS + 10 * 60_000;

const manifest = (await get(`/v1/events/${EVENT}/manifest`)).json();
console.log(`\n  manifest`);
console.log(`    ${manifest.count} credentials, sequence ${manifest.sequence}`);
console.log(`    expires ${new Date(manifest.expiresAt).toISOString()}`);
console.log(`    contains a face template: ${/embedding|descriptor|vector/i.test(JSON.stringify(manifest)) ? 'YES — BUG' : 'no'}`);

// Simulate a night: admit everyone, with one lane briefly offline scanning a
// ticket that another lane already took.
const entries = manifest.entries as Array<{ ticketId: string; identityId: string }>;
const scans = entries.map((e, i) => ({
  ticketId: e.ticketId,
  identityId: e.identityId,
  lane: `lane_${(i % 8) + 1}`,
  decidedAt: DOORS + 60_000 + i * 900,
  outcome: i % 80 === 40 ? 'fallback' : 'admit',
  code: i % 80 === 40 ? 'NO_MATCH' : 'MATCHED',
  matchScore: i % 80 === 40 ? 0.41 : 0.93 + (i % 6) / 100,
  manifestSequence: manifest.sequence,
  offline: i % 11 === 0,
}));

// Pick a ticket that was actually admitted, so the injected second scan at a
// stale offline lane really is a double entry.
const firstEntry = entries[1];
if (firstEntry) {
  scans.push({
    ticketId: firstEntry.ticketId,
    identityId: firstEntry.identityId,
    lane: 'lane_9',
    decidedAt: DOORS + 95_000,
    outcome: 'admit',
    code: 'MATCHED',
    matchScore: 0.94,
    manifestSequence: manifest.sequence - 1, // a stale lane
    offline: true,
  });
}

await post(`/v1/events/${EVENT}/attestations`, { attestations: scans });
const recon = (await get(`/v1/events/${EVENT}/reconciliation`)).json();

console.log(`\n  the night`);
console.log(`    scans           ${recon.scans}`);
console.log(`    admitted        ${recon.admitted}`);
console.log(`    fallback        ${recon.fallback}  (${(recon.fallbackRate * 100).toFixed(2)}% — target is under 1.5%)`);
console.log(`    double entries  ${recon.doubleEntries.length}`);
for (const d of recon.doubleEntries) {
  const lanes = d.lanes.map((l: { lane: string; offline: boolean }) => `${l.lane}${l.offline ? ' (offline)' : ''}`);
  console.log(`      ${d.ticketId} at ${lanes.join(' then ')}`);
}

// ─── the right to be forgotten ───────────────────────────────────────────────

const leaver = fans[FANS - 1] as string;
const withdrawal = (await post(`/v1/identities/${leaver}/consents/biometric_enrolment/withdraw`, {})).json();

console.log(`\n  consent withdrawal`);
console.log(`    templates destroyed  ${withdrawal.receipt.deletedCount}`);
console.log(`    receipt              ${withdrawal.receipt.receiptId}`);
console.log(`    digest verifies      ${vault.store.verifyReceipt(withdrawal.receipt) ? 'yes' : 'NO — investigate'}`);
console.log(`    tampered digest      ${vault.store.verifyReceipt({ ...withdrawal.receipt, deletedCount: 99 }) ? 'ACCEPTED — BUG' : 'rejected'}`);
console.log(`    still enrolled       ${vault.store.isEnrolled(leaver, 'global') ? 'YES — BUG' : 'no'}`);

// The consent ledger keeps the grant. What they agreed to, and when, outlives
// the permission itself — that history is the artefact a regulator asks for.
const ledger = (await get(`/v1/identities/${leaver}/consents`)).json();
console.log(`    ledger rows kept     ${ledger.history.length} (grant + withdrawal)`);

console.log(`\n  database written to ${DB_PATH}`);
console.log(`  start the API against it with:  npm run dev\n`);

await app.server.close();
await vault.server.close();
vault.store.close();
app.db.close();
