/// <reference lib="dom" />
// The seeding below runs inside the page, so this file needs the DOM types the
// rest of the suite deliberately does without.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The gate's operator surface.
 *
 * Not the matcher — that is a camera, a model and 128 floats, and it has its own
 * tests in packages/biometrics and packages/ui. This is the screen a steward
 * actually watches, and what it says when something is wrong is the whole of
 * their information.
 *
 * The lane restores itself wholly from localStorage, which is what makes this
 * testable without a network, a camera or a key ceremony: a device that has been
 * provisioned and then reopened is exactly the state seeded here, and it is the
 * state every lane is in for the second and every subsequent hour of an event.
 *
 * What is worth guarding is the banner, and specifically its order. A lane that
 * cannot file its decisions has a worse problem than a lane a few seconds
 * behind, and if those two ever swap places the more serious one becomes
 * invisible exactly when both are true — which is the likeliest moment for both
 * to be true.
 */

const GATE = 'http://127.0.0.1:8100/';

interface Seed {
  sequence?: number;
  serverSequence?: number;
  expiresAt?: number;
  lane?: string;
  queued?: number;
  unsigned?: number;
  refused?: number;
  stats?: { admit: number; deny: number; fallback: number };
  /** What the sync endpoint answers, when the test wants the lane to sync. */
  deltas?: { serverSequence: number; deltas: unknown[] };
  /** What the attestation upload answers. A 202 with a breakdown, as in production. */
  upload?: { inserted: number; duplicates: number; rejected: unknown[] };
}

/**
 * A provisioned lane, as localStorage holds it.
 *
 * `template` is a plain array here because that is how `persist` writes it; the
 * app turns it back into a Float32Array on restore, and a test that seeded the
 * typed array directly would be testing a state the app never produces.
 */
async function openLane(page: Page, seed: Seed = {}): Promise<void> {
  const {
    sequence = 4,
    expiresAt = Date.now() + 6 * 3_600_000,
    lane = 'Lane A',
    queued = 0,
    unsigned = 0,
    refused = 0,
    stats = { admit: 0, deny: 0, fallback: 0 },
    deltas,
    upload,
  } = seed;

  await page.addInitScript(
    ([sequence, expiresAt, lane, queued, unsigned, refused, stats]) => {
      const template = Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));
      localStorage.setItem(
        'rexell.gate',
        JSON.stringify({
          config: { apiBase: 'http://127.0.0.1:8100', eventId: 'evt_test', scannerId: 'scn_test', lane, gateGroup: 'north', allowReentry: false },
          manifest: {
            eventId: 'evt_test',
            sequence,
            expiresAt,
            entries: [
              { ticketId: 'tkt_one', identityId: 'idn_one', template, admitFrom: 0, admitUntil: expiresAt, revoked: false },
            ],
          },
          admitted: [],
          queued: Array.from({ length: queued as number }, (_, i) => ({ id: `q${i}` })),
          unsigned: Array.from({ length: unsigned as number }, (_, i) => ({ id: `u${i}` })),
          stats,
          refused,
        }),
      );
    },
    [sequence, expiresAt, lane, queued, unsigned, refused, stats] as const,
  );

  /*
   * The catch-all goes on first, because Playwright runs the most recently
   * registered handler first. Registered the other way round it swallows the
   * stubs below and every sync-driven test quietly sees an offline lane.
   *
   * Aborting rather than leaving it to hang: a lane reaching for a server this
   * test did not stub is a fact worth failing on, not waiting for.
   */
  await page.route('**/v1/**', (r) => r.abort());
  if (deltas) await page.route('**/deltas**', (r) => r.fulfill({ json: deltas }));
  if (upload) await page.route('**/attestations/signed', (r) => r.fulfill({ status: 202, json: upload }));

  await page.goto(GATE);
  await expect(page.locator('#laneLabel')).not.toHaveText('LANE —');
}

const banner = (page: Page) => page.locator('#banner');

test('an unprovisioned device says how to provision it', async ({ page }) => {
  await page.route('**/v1/**', (r) => r.abort());
  await page.goto(GATE);

  await expect(banner(page)).toContainText('No manifest loaded');
  await expect(banner(page)).toContainText('?config=');
  await expect(page.locator('#laneLabel')).toHaveText('LANE —');
});

test('a restored lane comes back with its manifest and its name', async ({ page }) => {
  await openLane(page, { sequence: 7 });

  await expect(page.locator('#laneLabel')).toHaveText('LANE A');
  await expect(page.locator('#syncPill')).toHaveText('seq 7');
  await expect(page.locator('#queuePill')).toHaveText('0 queued');
  await expect(banner(page)).not.toHaveClass(/show/);
});

test('does not print LANE LANE A', async ({ page }) => {
  // The config already carries the word and the header adds it. Tolerated at
  // the display layer rather than fixed at the two places that build a config,
  // because provisioned devices are still carrying the old spelling.
  await openLane(page, { lane: 'Lane A' });
  await expect(page.locator('#laneLabel')).toHaveText('LANE A');

  await openLane(page, { lane: 'North 3' });
  await expect(page.locator('#laneLabel')).toHaveText('LANE NORTH 3');
});

test('counts work waiting to be filed, signed or not', async ({ page }) => {
  // Both queues are the operator's problem and neither is visible anywhere
  // else, so the pill adds them rather than picking one.
  await openLane(page, { queued: 3, unsigned: 2 });
  await expect(page.locator('#queuePill')).toHaveText('5 queued');
});

test('warns that a lane behind on updates may admit a resold ticket', async ({ page }) => {
  // The server has moved on and this lane has not caught up. Deltas are empty
  // rather than absent: the sequence number is the news, and the lane has to
  // say so whether or not it has the records to apply.
  await openLane(page, {
    sequence: 4,
    deltas: { serverSequence: 9, deltas: [] },
  });

  await expect(page.locator('#syncPill')).toHaveText('seq 4 · 5 behind');
  await expect(page.locator('#syncPill')).toHaveClass(/bad/);
  await expect(banner(page)).toHaveClass(/show/);
  await expect(banner(page)).toContainText('5 updates behind');
  // The consequence, in the operator's terms, not the system's.
  await expect(banner(page)).toContainText('Resold tickets may still scan as valid');
});

test('counts attestations the server refused inside a 202', async ({ page }) => {
  /*
   * The upload endpoint answers 202 with a per-record breakdown, so a batch in
   * which every signature was rejected is still a 202. This used to be read as
   * success and the night's evidence was discarded silently — the one failure
   * that destroys the reason for signing at all.
   */
  await openLane(page, {
    sequence: 4,
    queued: 3,
    deltas: { serverSequence: 4, deltas: [] },
    upload: { inserted: 0, duplicates: 0, rejected: [{ index: 0, reason: 'BAD_SIGNATURE' }, { index: 1, reason: 'BAD_SIGNATURE' }, { index: 2, reason: 'BAD_SIGNATURE' }] },
  });

  await expect(banner(page)).toHaveClass(/show/);
  await expect(banner(page)).toContainText('3 decisions were refused by the server');
  await expect(banner(page)).toContainText('not in the record');
});

test('a refused decision outranks a stale manifest', async ({ page }) => {
  await openLane(page, { refused: 2 });

  await expect(banner(page)).toHaveClass(/show/);
  await expect(banner(page)).toContainText('refused by the server');
  await expect(banner(page)).toContainText('Call the supervisor');
  // Not the staleness message, even though this lane could also be behind.
  await expect(banner(page)).not.toContainText('updates behind');
});

test('says one decision was refused, not one decision were refused', async ({ page }) => {
  await openLane(page, { refused: 1 });
  await expect(banner(page)).toContainText('1 decision was refused by the server and is not in the record');
});

test('shows the running tally a steward is watching', async ({ page }) => {
  await openLane(page, { stats: { admit: 180, deny: 2, fallback: 18 } });

  await expect(page.locator('#sAdmit')).toHaveText('180');
  await expect(page.locator('#sDeny')).toHaveText('2');
  await expect(page.locator('#sFall')).toHaveText('18');
  // The number the venue is judged on: 18 of 200.
  await expect(page.locator('#sRate')).toHaveText('9.0%');
});

test('reports going offline without losing the lane', async ({ page }) => {
  await openLane(page, { sequence: 4, queued: 2 });
  await expect(page.locator('#netPill')).toHaveText('online');

  await page.context().setOffline(true);
  await page.evaluate(() => dispatchEvent(new Event('offline')));

  await expect(page.locator('#netPill')).toHaveText('offline');
  // Offline is not an error state. The lane keeps deciding on what it has.
  await expect(page.locator('#syncPill')).toHaveText('seq 4');
  await expect(page.locator('#queuePill')).toHaveText('2 queued');
});
