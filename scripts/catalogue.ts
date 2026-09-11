/**
 * The event catalogue, in one place.
 *
 * Imported by the script that publishes these events and by the one that
 * draws their artwork, so a poster cannot end up belonging to an event that
 * no longer exists — or worse, quietly belong to the wrong one.
 *
 * Dates and venues are from public listings. ReXell has no relationship with
 * any of these artists, venues or promoters; the organizers are fictional and
 * the prices and allocations are illustrative.
 */

export interface TierSpec {
  key: string;
  name: string;
  rupees: number;
  allocation: number;
  /** null means the tier is soulbound — it cannot be resold at all. */
  capPct: number | null;
  organizerPct?: number;
  artistPct?: number;
}

export interface EventSpec {
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
export const CATALOGUE: readonly EventSpec[] = [
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
];
