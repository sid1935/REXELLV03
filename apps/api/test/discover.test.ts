import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, availabilityOf, epochMs, isDiscoverable } from '@rexell/domain';
import type { EpochMs } from '@rexell/domain';
import { buildApp } from '../src/app.js';
import type { App } from '../src/app.js';

/**
 * The public surface.
 *
 * Most of this file is about what is NOT in a response. That is the hard part
 * of a public API: a field added carelessly is published forever, and the
 * person it exposes is not the one who added it.
 */

const T0 = 1_780_000_000_000;
const DOORS = T0 + 30 * DAY;

let app: App;
let clock = T0;
const now = (): EpochMs => epochMs(clock);

const post = (url: string, body: unknown = {}, key?: string) =>
  app.server.inject({
    method: 'POST',
    url,
    payload: body as object,
    ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
  });
const get = (url: string, key?: string) =>
  app.server.inject({ method: 'GET', url, ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}) });

function eventPayload(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    organizerId: `org_${id}`,
    name: `Festival ${id}`,
    capacity: 1000,
    salesOpenAt: T0,
    salesCloseAt: DOORS - 2 * HOUR,
    doorsOpenAt: DOORS,
    endsAt: DOORS + 10 * HOUR,
    maxTicketsPerIdentity: 4,
    allowReentry: false,
    tiers: [
      {
        id: `${id}_ga`,
        eventId: id,
        name: 'General Admission',
        faceValue: 220_000,
        allocation: 500,
        resale: {
          mode: 'capped',
          maxPriceBps: 11_000,
          minPriceBps: 5_000,
          opensAt: T0,
          closesAt: DOORS,
          cooldownMs: 0,
          maxResalesPerTicket: 2,
          maxActiveListingsPerIdentity: 2,
          splits: { organizerBps: 700, platformBps: 300, rightsHolderBps: 200 },
        },
      },
    ],
    ...over,
  };
}

async function sell(tierId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    const id = (await post('/v1/identities', {})).json().identityId;
    const order = await post('/v1/orders', { identityId: id, tierId, quantity: 1 });
    if (order.statusCode !== 201) continue;
    await post(`/v1/orders/${order.json().orderId}/pay`, {});
  }
}

beforeEach(async () => {
  clock = T0;
  app = buildApp({ now, devMode: true });
  await app.server.ready();
});
afterEach(async () => {
  await app.server.close();
  app.db.close();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the public event view does not leak the organizer', () => {
  it('publishes no sales figures, no commission split and no internal counters', async () => {
    await post('/v1/events', { event: eventPayload('evt_a'), organizerName: 'Pinewood Live' });
    await sell('evt_a_ga', 40);

    const body = (await get('/v1/events/evt_a')).body;
    const json = (await get('/v1/events/evt_a')).json();

    // The organizer's sales curve. Polling this hourly reconstructs their whole
    // onsale, and they never agreed to publish it.
    expect(body).not.toMatch(/"sold"/);
    expect(body).not.toMatch(/"held"/);
    expect(body).not.toMatch(/"remaining"/);
    expect(body).not.toMatch(/"allocation"/);

    // Their private terms with ReXell and with the artist.
    expect(body).not.toMatch(/organizerBps|platformBps|rightsHolderBps|commissionBps/);

    // An internal counter that leaks ticketing volume.
    expect(body).not.toMatch(/manifestSequence/);

    // A tenant identifier, useful only for enumeration.
    expect(body).not.toMatch(/org_evt_a/);
    expect(json.organizer).toBe('Pinewood Live'); // the name is fine; the id is not

    // And the number 40 must not appear as a count anywhere.
    expect(json.tiers[0].sold).toBeUndefined();
  });

  it('still gives a fan everything they need to decide', async () => {
    await post('/v1/events', { event: eventPayload('evt_b'), organizerName: 'Pinewood Live' });
    const e = (await get('/v1/events/evt_b')).json();

    expect(e).toMatchObject({ id: 'evt_b', organizer: 'Pinewood Live', onSale: true, maxTicketsPerIdentity: 4 });
    expect(e.tiers[0]).toMatchObject({ name: 'General Admission', faceValueMinor: 220_000 });
    // The ceiling is a promise being made to them, so it is published.
    expect(e.tiers[0].resale).toMatchObject({ allowed: true, ceilingMinor: 242_000 });
    // The policy hash stays public: anchoring terms is worthless if nobody
    // outside can check them.
    expect(e.policyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('says resale is off rather than publishing a meaningless ceiling', async () => {
    const bound = eventPayload('evt_c');
    bound.tiers[0]!.resale = { ...bound.tiers[0]!.resale, mode: 'bound' };
    await post('/v1/events', { event: bound });

    const e = (await get('/v1/events/evt_c')).json();
    expect(e.tiers[0].resale).toEqual({ allowed: false });
  });

  it('keeps the organizer’s own numbers precise behind their key', async () => {
    const key = (await post('/v1/organizers', { name: 'Precise Promotions' })).json().apiKey as string;
    const created = await post(
      '/v1/organizer/events',
      { event: { ...eventPayload('evt_d'), organizerId: undefined } },
      key,
    );
    expect(created.statusCode).toBe(201);
    await sell('evt_d_ga', 12);

    const mine = (await get('/v1/events/evt_d/analytics', key)).json();
    expect(mine.sales.sold).toBe(12);
    expect(mine.sales.tiers[0].held).toBe(0);
    expect(mine.sales.tiers[0].remaining).toBe(488);
  });
});

describe('availability is a band, not a number', () => {
  it('bands by what is left', () => {
    expect(availabilityOf({ allocation: 1000, sold: 0, held: 0 })).toBe('available');
    expect(availabilityOf({ allocation: 1000, sold: 910, held: 0 })).toBe('limited');
    expect(availabilityOf({ allocation: 1000, sold: 985, held: 0 })).toBe('last_few');
    expect(availabilityOf({ allocation: 1000, sold: 1000, held: 0 })).toBe('sold_out');
  });

  it('counts somebody else’s open cart as unavailable', () => {
    // Showing held inventory as available produces a SOLD_OUT at checkout,
    // which is worse than showing a smaller number to begin with.
    expect(availabilityOf({ allocation: 100, sold: 0, held: 100 })).toBe('sold_out');
  });

  it('uses an absolute floor as well as a proportion', () => {
    // Twenty left is "last few" at a stadium and at a club, even though the
    // percentages are nothing alike.
    expect(availabilityOf({ allocation: 100_000, sold: 99_985, held: 0 })).toBe('last_few');
    expect(availabilityOf({ allocation: 200, sold: 185, held: 0 })).toBe('last_few');
  });

  it('never reports sold out while tickets remain', () => {
    for (let sold = 0; sold < 1000; sold += 7) {
      const band = availabilityOf({ allocation: 1000, sold, held: 0 });
      expect(band === 'sold_out', `claimed sold out with ${1000 - sold} left`).toBe(false);
    }
  });

  it('never manufactures urgency on a small event', () => {
    // A thirty-ticket event with thirty left is available, not "selling fast".
    // The absolute floors are capped against the allocation for exactly this.
    expect(availabilityOf({ allocation: 30, sold: 0, held: 0 })).toBe('available');
    expect(availabilityOf({ allocation: 12, sold: 0, held: 0 })).toBe('available');
    expect(availabilityOf({ allocation: 5, sold: 0, held: 0 })).toBe('available');
  });

  it('moves through the bands as an event sells', async () => {
    const small = eventPayload('evt_e');
    small.tiers[0]!.allocation = 30;
    small.capacity = 30;
    await post('/v1/events', { event: small });

    expect((await get('/v1/events/evt_e')).json().availability).toBe('available');
    await sell('evt_e_ga', 22);
    expect((await get('/v1/events/evt_e')).json().availability).toBe('limited');
    await sell('evt_e_ga', 6);
    expect((await get('/v1/events/evt_e')).json().availability).toBe('last_few');
    await sell('evt_e_ga', 2);
    expect((await get('/v1/events/evt_e')).json().availability).toBe('sold_out');
  });
});

describe('discovery', () => {
  it('lists what is on sale, cheapest tier first shown', async () => {
    await post('/v1/events', { event: eventPayload('evt_1'), organizerName: 'Pinewood Live' });
    await post('/v1/events', { event: eventPayload('evt_2'), organizerName: 'Other Promoter' });

    const d = (await get('/v1/discover')).json();
    expect(d.total).toBe(2);
    expect(d.events.map((e: { id: string }) => e.id).sort()).toEqual(['evt_1', 'evt_2']);
    expect(d.events[0]).toMatchObject({ organizer: expect.any(String), fromMinor: 220_000, resaleAllowed: true });
  });

  it('leaks nothing there either', async () => {
    await post('/v1/events', { event: eventPayload('evt_1') });
    await sell('evt_1_ga', 25);

    const body = (await get('/v1/discover')).body;
    expect(body).not.toMatch(/"sold"|"held"|"allocation"|Bps|manifestSequence/);
  });

  it('hides an event whose sales have not opened', async () => {
    await post('/v1/events', { event: eventPayload('evt_future', { salesOpenAt: T0 + 5 * DAY }) });
    expect((await get('/v1/discover')).json().total).toBe(0);

    clock = T0 + 6 * DAY;
    expect((await get('/v1/discover')).json().total).toBe(1);
  });

  it('hides an event whose sales have closed', async () => {
    await post('/v1/events', { event: eventPayload('evt_1') });
    expect((await get('/v1/discover')).json().total).toBe(1);

    clock = DOORS - HOUR; // past salesCloseAt
    expect((await get('/v1/discover')).json().total).toBe(0);
  });

  it('keeps a sold-out event listed', async () => {
    // A fan wants to know the show exists and that resale may open. Hiding it
    // produces "is this cancelled?" rather than fewer support tickets.
    const small = eventPayload('evt_gone');
    small.tiers[0]!.allocation = 5;
    small.capacity = 5;
    await post('/v1/events', { event: small });
    await sell('evt_gone_ga', 5);

    const d = (await get('/v1/discover')).json();
    expect(d.total).toBe(1);
    expect(d.events[0]).toMatchObject({ availability: 'sold_out', availabilityLabel: 'Sold out' });
  });

  it('pages, and clamps a caller asking for everything', async () => {
    for (let i = 0; i < 5; i += 1) await post('/v1/events', { event: eventPayload(`evt_p${i}`) });

    const first = (await get('/v1/discover?limit=2')).json();
    expect(first.events).toHaveLength(2);
    expect(first.total).toBe(5);

    const second = (await get('/v1/discover?limit=2&offset=2')).json();
    expect(second.events).toHaveLength(2);
    expect(second.events[0].id).not.toBe(first.events[0].id);

    // A crawler asking for ten thousand gets a hundred.
    const greedy = (await get('/v1/discover?limit=10000')).json();
    expect(greedy.limit).toBe(100);
  });

  it('frees lapsed holds before answering, so nothing looks falsely gone', async () => {
    const small = eventPayload('evt_hold');
    small.tiers[0]!.allocation = 3;
    small.capacity = 3;
    await post('/v1/events', { event: small });

    const id = (await post('/v1/identities', {})).json().identityId;
    await post('/v1/orders', { identityId: id, tierId: 'evt_hold_ga', quantity: 3 });
    expect((await get('/v1/discover')).json().events[0].availability).toBe('sold_out');

    clock = T0 + 9 * 60_000; // past the hold TTL
    expect((await get('/v1/discover')).json().events[0].availability).not.toBe('sold_out');
  });

  it('is cacheable, because it is the endpoint a crawler hits hardest', async () => {
    await post('/v1/events', { event: eventPayload('evt_1') });
    const res = await get('/v1/discover');
    expect(res.headers['cache-control']).toMatch(/max-age/);
  });
});

describe('isDiscoverable', () => {
  const event = { salesOpenAt: 100, salesCloseAt: 200, endsAt: 300 };

  it('is true only while sales are open', () => {
    expect(isDiscoverable(event, 99)).toBe(false);
    expect(isDiscoverable(event, 100)).toBe(true);
    expect(isDiscoverable(event, 199)).toBe(true);
    expect(isDiscoverable(event, 200)).toBe(false);
  });

  it('is false once the event has ended, whatever the sales window says', () => {
    expect(isDiscoverable({ salesOpenAt: 0, salesCloseAt: 999, endsAt: 50 }, 60)).toBe(false);
  });
});

describe('searching the catalogue', () => {
  /**
   * Searched in SQL rather than filtered after paging.
   *
   * Filtering a page is not searching a catalogue: the page caps at 100, so a
   * client-side filter stops finding events the moment there are more than
   * that, and does it silently.
   */
  beforeEach(async () => {
    await post('/v1/events', {
      event: eventPayload('evt_gnr', { name: "Guns N' Roses", venue: 'NICE Grounds, Bengaluru' }),
      organizerName: 'Meridian Festivals',
    });
    await post('/v1/events', {
      event: eventPayload('evt_anyma', { name: 'Anyma presents AEDEN', venue: 'Mahalaxmi Race Course, Mumbai' }),
      organizerName: 'Southside Venues',
    });
  });

  const names = async (q: string) => {
    const res = await get(`/v1/discover?q=${encodeURIComponent(q)}`);
    expect(res.statusCode).toBe(200);
    return (res.json().events as Array<{ name: string }>).map((e) => e.name).sort();
  };

  it('matches the event name', async () => {
    expect(await names('guns')).toEqual(["Guns N' Roses"]);
  });

  it('matches the venue, which is how somebody looks for a city', async () => {
    expect(await names('mumbai')).toEqual(['Anyma presents AEDEN']);
  });

  it('matches the organizer', async () => {
    expect(await names('meridian')).toEqual(["Guns N' Roses"]);
  });

  it('ignores case', async () => {
    expect(await names('ANYMA')).toEqual(['Anyma presents AEDEN']);
  });

  it('matches across words in a venue', async () => {
    expect(await names('race course')).toEqual(['Anyma presents AEDEN']);
  });

  it('returns nothing for a term that matches nothing', async () => {
    expect(await names('zzzz')).toEqual([]);
  });

  it('treats a wildcard as a character, not a wildcard', async () => {
    // Unescaped, `_` matches any single character and `%` matches everything,
    // so a search for either would return the whole catalogue and look like it
    // had worked.
    expect(await names('_')).toEqual([]);
    expect(await names('%')).toEqual([]);
  });

  it('is not confused by a quote', async () => {
    const res = await get(`/v1/discover?q=${encodeURIComponent("o'brien")}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([]);
  });

  it('returns the whole catalogue when the term is blank', async () => {
    expect((await names('')).length).toBe(2);
    expect(((await get('/v1/discover')).json().events as unknown[]).length).toBe(2);
  });

  it('echoes the term back, so a client can tell which response it is', async () => {
    expect((await get('/v1/discover?q=guns')).json().q).toBe('guns');
    expect((await get('/v1/discover')).json().q).toBeUndefined();
  });

  it('still hides what the public must not see', async () => {
    const event = (await get('/v1/discover?q=guns')).json().events[0];
    for (const leaked of ['sold', 'held', 'allocation', 'commissionBps', 'organizerId', 'manifestSequence']) {
      expect(event).not.toHaveProperty(leaked);
    }
  });
});
