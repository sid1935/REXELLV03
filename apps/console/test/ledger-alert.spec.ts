/// <reference lib="dom" />
// The callbacks below run inside the page, not in node, so this file needs the
// DOM types the rest of the suite deliberately does without.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The ledger alert, in a browser.
 *
 * What it guards is a promise the outbox makes: a chain write that was sent and
 * never confirmed is deliberately never retried, because retrying a mint that
 * may have landed is how one seat becomes two tokens. It waits for a person
 * instead — so a person has to be told, and this page is the only thing that
 * tells them.
 *
 * The states are worth naming precisely, because getting them wrong in either
 * direction is a real cost. Silent when something is stranded means the work
 * sits there for ever. Loud when the chain is merely behind — which is routine,
 * and self-healing — teaches everybody to ignore the banner by the third time
 * they see it.
 */

const CONSOLE = 'http://127.0.0.1:8110/';
const HOUR = 3_600_000;

const CHAIN = {
  healthy: {
    configured: true, chainUp: true, pending: 0, confirmed: 40, failed: 0,
    submitted: 0, oldestSubmittedAt: null, strandedMs: 0, oldestPendingAgeMs: 0,
  },
  stranded: {
    configured: true, chainUp: true, pending: 1, confirmed: 40, failed: 0,
    submitted: 1, oldestSubmittedAt: 1, strandedMs: 3 * HOUR, oldestPendingAgeMs: 3 * HOUR,
  },
  behind: {
    configured: true, chainUp: false, pending: 6, confirmed: 40, failed: 2,
    submitted: 0, oldestSubmittedAt: null, strandedMs: 0, oldestPendingAgeMs: 47 * 60_000,
  },
  /** A drain in flight right now. Not stranded, and must not say it is. */
  draining: {
    configured: true, chainUp: true, pending: 1, confirmed: 40, failed: 0,
    submitted: 1, oldestSubmittedAt: 1, strandedMs: 4_000, oldestPendingAgeMs: 4_000,
  },
  /** No chain at all, which is a supported way to run this. */
  unconfigured: { configured: false },
};

async function openConsole(page: Page, status: unknown, { signedIn = true } = {}): Promise<void> {
  await page.route('**/v1/me', (r) =>
    r.fulfill({ json: { organizerId: 'org_test', name: 'Pinewood Live', scopes: [], events: 1 } }),
  );
  await page.route('**/v1/events', (r) =>
    r.fulfill({ json: { events: [{ id: 'evt_test', name: 'Sunburn Weekender 2026', capacity: 200, doorsOpenAt: Date.now() }] } }),
  );
  await page.route('**/v1/keys', (r) => r.fulfill({ json: { keys: [] } }));
  await page.route('**/v1/chain/status', (r) => r.fulfill({ json: status as object }));

  if (signedIn) {
    await page.addInitScript(() => localStorage.setItem('rexell.key', 'rxl_test_key'));
  }

  /*
   * Wait for the status call itself, not for the page to look ready.
   *
   * Asserting the banner is hidden before that request has even been made would
   * pass against a page that never renders it at all, which is precisely the
   * bug those tests exist to catch.
   */
  const asked = signedIn ? page.waitForResponse((r) => r.url().includes('/v1/chain/status')) : null;
  await page.goto(CONSOLE);
  if (asked) {
    await asked;
    // The handler resolves a promise and then writes the DOM; give it that turn.
    await page.waitForFunction(() => document.getElementById('ledgerAlert')?.dataset['rendered'] === '1');
  }
}

const alert = (page: Page) => page.locator('#ledgerAlert');

test('says so, in the bad palette, when a write is stranded', async ({ page }) => {
  await openConsole(page, CHAIN.stranded);

  await expect(alert(page)).toBeVisible();
  await expect(alert(page)).toHaveClass(/is-bad/);
  await expect(alert(page)).toContainText('A ledger write needs attention');
  // The age is the number a reader acts on.
  await expect(alert(page)).toContainText('3 hours');
  // And it says what is not wrong, which is nearly everything.
  await expect(alert(page)).toContainText('gates are unaffected');
});

test('is quieter about a backlog, which resolves itself', async ({ page }) => {
  await openConsole(page, CHAIN.behind);

  await expect(alert(page)).toBeVisible();
  await expect(alert(page)).not.toHaveClass(/is-bad/);
  await expect(alert(page)).toContainText('catching up');
  await expect(alert(page)).toContainText('47 minutes');
});

test('says nothing at all when the ledger is keeping up', async ({ page }) => {
  await openConsole(page, CHAIN.healthy);
  await expect(alert(page)).toBeHidden();
});

test('does not mistake a drain in progress for a stranded one', async ({ page }) => {
  // Claimed four seconds ago: that is the drain working, not a write to chase.
  await openConsole(page, CHAIN.draining);
  await expect(alert(page)).toBeHidden();
});

test('stays out of the way when there is no chain configured', async ({ page }) => {
  await openConsole(page, CHAIN.unconfigured);
  await expect(alert(page)).toBeHidden();
});

test('never shows platform-wide counts to one organizer', async ({ page }) => {
  await openConsole(page, CHAIN.stranded);
  await expect(alert(page)).toBeVisible();

  /*
   * /v1/chain/status is platform-wide, so `confirmed` is roughly every
   * organizer's sales added together. The age belongs here; the volume does not.
   */
  const text = (await alert(page).textContent()) ?? '';
  expect(text).not.toContain('40');
  expect(text).not.toMatch(/\b6\b/);
});

test('shows nothing to somebody who is not signed in', async ({ page }) => {
  await openConsole(page, CHAIN.stranded, { signedIn: false });
  await expect(alert(page)).toBeHidden();
});
