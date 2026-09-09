import {
  DAY,
  HOUR,
  MINUTE,
  epochMs,
  eventId,
  identityId,
  laneId,
  listingId,
  minor,
  organizerId,
  templateRef,
  ticketId,
  tierId,
} from '../src/index.js';
import type {
  EventDef,
  Listing,
  ManifestEntry,
  PurchaserContext,
  ResalePolicy,
  Ticket,
  TicketTier,
} from '../src/index.js';

/** A fixed instant so every time-dependent test reads as an absolute statement. */
export const T0 = epochMs(1_780_000_000_000);

export const DOORS = epochMs(T0 + 30 * DAY);

export const cappedPolicy: ResalePolicy = {
  mode: 'capped',
  maxPriceBps: 11_000, // 110% of face
  minPriceBps: 5_000, // 50% of face — stops wash-trading for nothing
  opensAt: epochMs(T0 + 1 * DAY),
  closesAt: epochMs(DOORS - 6 * HOUR),
  cooldownMs: 24 * HOUR,
  maxResalesPerTicket: 2,
  maxActiveListingsPerIdentity: 2,
  splits: { organizerBps: 700, platformBps: 300, rightsHolderBps: 200 },
};

export const boundPolicy: ResalePolicy = {
  ...cappedPolicy,
  mode: 'bound',
};

export const GA_TIER_ID = tierId('tier_ga');
export const VIP_TIER_ID = tierId('tier_vip');
export const EVENT_ID = eventId('evt_sunburn26');

export const gaTier: TicketTier = {
  id: GA_TIER_ID,
  eventId: EVENT_ID,
  name: 'General Admission',
  faceValue: minor(220_000), // ₹2,200.00
  allocation: 10_000,
  resale: cappedPolicy,
};

export const vipTier: TicketTier = {
  id: VIP_TIER_ID,
  eventId: EVENT_ID,
  name: 'VIP',
  faceValue: minor(850_000), // ₹8,500.00
  allocation: 800,
  resale: boundPolicy,
};

export const festival: EventDef = {
  id: EVENT_ID,
  organizerId: organizerId('org_pinewood'),
  name: 'Sunburn Weekender 2026',
  capacity: 12_000,
  salesOpenAt: T0,
  salesCloseAt: epochMs(DOORS - 2 * HOUR),
  doorsOpenAt: DOORS,
  endsAt: epochMs(DOORS + 10 * HOUR),
  tiers: [gaTier, vipTier],
  maxTicketsPerIdentity: 4,
  allowReentry: false,
};

export const ALICE = identityId('id_alice');
export const BOB = identityId('id_bob');
export const MALLORY = identityId('id_mallory');

export function buyer(overrides: Partial<PurchaserContext> = {}): PurchaserContext {
  return {
    identityId: ALICE,
    enrolled: true,
    blocked: false,
    ticketsHeldForEvent: 0,
    riskVerdict: 'allow',
    ...overrides,
  };
}

export function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: ticketId('tkt_0001'),
    eventId: EVENT_ID,
    tierId: GA_TIER_ID,
    ownerIdentityId: ALICE,
    state: 'issued',
    acquiredAt: T0,
    resaleCount: 0,
    ...overrides,
  };
}

export function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: listingId('lst_0001'),
    ticketId: ticketId('tkt_0001'),
    sellerIdentityId: ALICE,
    price: minor(242_000), // ₹2,420.00 — exactly the 110% ceiling
    state: 'active',
    listedAt: epochMs(T0 + 2 * DAY),
    ...overrides,
  };
}

export function manifestEntry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    ticketId: ticketId('tkt_0001'),
    identityId: ALICE,
    tierId: GA_TIER_ID,
    templateRef: templateRef('tpl_alice_v3'),
    gates: [],
    admitFrom: epochMs(DOORS - 30 * MINUTE),
    admitUntil: epochMs(DOORS + 8 * HOUR),
    revoked: false,
    ...overrides,
  };
}

export const LANE_A = laneId('lane_a');
