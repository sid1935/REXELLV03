/// <reference lib="dom" />
// The seeding below runs inside the page, so this file needs the DOM types the
// rest of the suite deliberately does without.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The fan app.
 *
 * Its one idea is that there is nothing to show at the gate, and almost every
 * screen exists to make that feel like a feature rather than a missing one. So
 * the things worth guarding here are mostly promises made in words: what is
 * kept, what is not, and what happens when the clever part cannot run.
 *
 * The matcher itself is not exercised. That needs a camera, a model and 128
 * floats, and it is tested in packages/biometrics and packages/ui where it can
 * be given known faces and measured. What is tested here is the app around it,
 * including — deliberately — how it behaves with no camera at all, because the
 * headless case is a real case and the app has a real answer for it.
 */

const FAN = 'http://127.0.0.1:8120/';

const EVENTS = {
  total: 2,
  limit: 20,
  offset: 0,
  events: [
    {
      id: 'evt_sunburn',
      name: 'Sunburn Weekender 2026',
      venue: 'NICE Grounds, Bengaluru',
      organizer: 'Meridian Festivals',
      doorsOpenAt: Date.now() + 30 * 86_400_000,
      endsAt: Date.now() + 31 * 86_400_000,
      salesCloseAt: Date.now() + 29 * 86_400_000,
      fromMinor: 400_000,
      resaleAllowed: true,
      availability: 'available',
      availabilityLabel: 'On sale',
    },
    {
      id: 'evt_indian_ocean',
      name: 'Indian Ocean',
      venue: 'Phoenix Marketcity, Bengaluru',
      organizer: 'Southside Venues',
      doorsOpenAt: Date.now() + 60 * 86_400_000,
      endsAt: Date.now() + 61 * 86_400_000,
      salesCloseAt: Date.now() + 59 * 86_400_000,
      fromMinor: 180_000,
      resaleAllowed: false,
      availability: 'available',
      availabilityLabel: 'On sale',
    },
  ],
};

interface Open {
  /** An identity already enrolled on this device. */
  enrolled?: boolean;
  /** `#start`, `#browse`, `#signin` — how the marketing site hands somebody over. */
  intent?: string;
  tickets?: unknown[];
}

async function openFan(page: Page, { enrolled = false, intent = '', tickets = [] }: Open = {}): Promise<void> {
  /*
   * Search is the server's job here, and the fixture does it the same way, so
   * the test covers what the app actually does: debounce, send the term, render
   * what comes back. A fixture that returned everything regardless would pass
   * against an app that never sent the query at all.
   */
  await page.route('**/v1/discover**', (r) => {
    const q = (new URL(r.request().url()).searchParams.get('q') ?? '').toLowerCase();
    const events = q
      ? EVENTS.events.filter((e) => `${e.name} ${e.venue}`.toLowerCase().includes(q))
      : EVENTS.events;
    return r.fulfill({ json: { ...EVENTS, total: events.length, events } });
  });
  await page.route('**/v1/identities/*/tickets', (r) => r.fulfill({ json: { tickets } }));
  await page.route('**/v1/identities/*/consents', (r) => r.fulfill({ json: { consents: [] } }));
  // A ticket card names its event, and the app fetches that separately — a
  // ticket list on its own renders nothing anybody would recognise.
  await page.route('**/v1/events/*', (r) => {
    const id = r.request().url().split('/').pop()?.split('?')[0];
    const event = EVENTS.events.find((e) => e.id === id);
    return event ? r.fulfill({ json: { ...event, tiers: [] } }) : r.fulfill({ status: 404, json: {} });
  });

  if (enrolled) {
    await page.addInitScript(() => {
      localStorage.setItem('rexell.fan.id', 'idn_test0000000000000');
      localStorage.setItem('rexell.fan.enrolled', 'true');
    });
  }
  await page.goto(FAN + intent);
}

test('opens on a landing page somebody has to choose past', async ({ page }) => {
  await openFan(page);

  await expect(page.locator('#landing')).toBeVisible();
  // The app is rendered underneath, so dismissing the landing reveals a ready
  // screen rather than an empty frame that then populates.
  await expect(page.locator('.shell')).toHaveAttribute('inert', '');
});

test('sends somebody who already pressed "browse" straight to the catalogue', async ({ page }) => {
  await openFan(page, { intent: '#browse' });

  await expect(page.locator('#landing')).toBeHidden();
  await expect(page.locator('#pageTitle')).toHaveText('Discover');
  await expect(page.getByText('Sunburn Weekender 2026')).toBeVisible();
});

test('consumes the intent, so a reload does not restart an abandoned flow', async ({ page }) => {
  await openFan(page, { intent: '#browse' });
  await expect(page.locator('#pageTitle')).toHaveText('Discover');

  expect(new URL(page.url()).hash).toBe('');

  await page.reload();
  // Back to the landing, not back into a flow they walked away from.
  await expect(page.locator('#landing')).toBeVisible();
});

test('asks for consent before it asks for a face', async ({ page }) => {
  await openFan(page, { intent: '#start' });

  const sheet = page.locator('#activeSheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('How long');
  await expect(sheet.locator('#consentYes')).toBeVisible();

  // The sentence the whole product rests on, and the one a regulator reads
  // first: this is optional, and refusing it does not cost entry.
  await expect(sheet).toContainText('You can attend without this');
  await expect(sheet).toContainText('Staffed entry is always available');

  // And there is a way out that is not the agree button.
  await expect(sheet.locator('#consentNo')).toBeVisible();
});

test('lets somebody decline and still use the app', async ({ page }) => {
  await openFan(page, { intent: '#start' });
  await page.locator('#consentNo').click();

  await expect(page.locator('#activeSheet')).toBeHidden();
  await expect(page.locator('#pageTitle')).toHaveText('Your tickets');
});

test('an enrolled device opens straight into the tickets it has', async ({ page }) => {
  await openFan(page, {
    enrolled: true,
    tickets: [
      {
        id: 'tkt_one',
        eventId: 'evt_sunburn',
        eventName: 'Sunburn Weekender 2026',
        venue: 'NICE Grounds, Bengaluru',
        tierName: 'General Admission',
        state: 'issued',
        doorsOpenAt: Date.now() + 30 * 86_400_000,
        faceValueMinor: 400_000,
      },
    ],
  });

  await expect(page.locator('#landing')).toBeHidden();
  await expect(page.locator('#pageTitle')).toHaveText('Your tickets');
  await expect(page.getByText('Sunburn Weekender 2026').first()).toBeVisible();
});

test('shows no barcode, no QR and nothing to screenshot', async ({ page }) => {
  await openFan(page, {
    enrolled: true,
    tickets: [
      {
        id: 'tkt_one',
        eventId: 'evt_sunburn',
        eventName: 'Sunburn Weekender 2026',
        venue: 'NICE Grounds, Bengaluru',
        tierName: 'General Admission',
        state: 'issued',
        doorsOpenAt: Date.now() + 30 * 86_400_000,
        faceValueMinor: 400_000,
      },
    ],
  });

  /*
   * The product claim, asserted rather than assumed.
   *
   * Every other ticketing app puts a code on this screen; the entire fraud
   * argument here is that there is nothing on it to forward or resell. If a
   * barcode ever arrives — as a convenience, as a fallback, as a partner
   * requirement — this is the test that has to be deleted on purpose.
   */
  const ticketScreen = page.locator('#view-tickets');
  await expect(ticketScreen.locator('canvas')).toHaveCount(0);
  await expect(ticketScreen.locator('svg.qr, .qr, [data-qr]')).toHaveCount(0);
  await expect(ticketScreen.locator('img[alt*="code" i]')).toHaveCount(0);
});

test('moves between tabs without losing the app', async ({ page }) => {
  await openFan(page, { enrolled: true });

  await page.locator('#tabs button[data-view="discover"]').click();
  await expect(page.locator('#pageTitle')).toHaveText('Discover');
  await expect(page.locator('#view-discover')).toBeVisible();

  await page.locator('#tabs button[data-view="you"]').click();
  await expect(page.locator('#pageTitle')).toHaveText('You');
  await expect(page.locator('#view-discover')).toBeHidden();
});

test('searches the catalogue it was given', async ({ page }) => {
  await openFan(page, { intent: '#browse' });

  await expect(page.getByText('Sunburn Weekender 2026')).toBeVisible();
  await expect(page.getByText('Indian Ocean')).toBeVisible();

  // Typed, not set: the input listener is what triggers the search.
  await page.locator('#discoverSearch').pressSequentially('indian');
  await expect(page.getByText('Indian Ocean')).toBeVisible();
  await expect(page.getByText('Sunburn Weekender 2026')).toHaveCount(0);
});

test('says plainly when no camera was available', async ({ page }) => {
  /*
   * The most important test in this file.
   *
   * With no camera the app derives a stand-in vector from the identity id so
   * the rest of the journey can be walked — and it is not a matcher and must
   * never be mistaken for one. Headless Chromium has no camera, which makes
   * this the default path here rather than an exotic one.
   *
   * If that sentence ever disappears, a stand-in vector starts looking exactly
   * like a working recogniser, on the screen whose whole job is explaining what
   * the system did with somebody's face.
   */
  const source = await page.request.get(FAN + 'fan.js');
  const text = await source.text();

  expect(text).toContain('No camera was available');
  expect(text).toContain('it will not match a face at the gate');
  // The marker the message hangs off, and the flag the gate would see.
  expect(text).toContain('simulated: true');
});
