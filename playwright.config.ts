import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * A face for the fake camera, if one has been made.
 *
 * Chromium will play a Y4M file as the webcam, which is the only way to put a
 * real face in front of the real matcher. The file is not in the repository:
 * the calibration photographs it is built from are Wikimedia Commons portraits
 * of named people, and `.calibration/` is gitignored deliberately — a public
 * repository is not the place for somebody's face, still less for the biometric
 * template derived from it.
 *
 * So `npm run face:fixture` builds it locally from a calibration set, and the
 * tests that need a face skip without it. Everything else about the camera —
 * that it opens, that the weights load, that an empty frame is refused rather
 * than turned into a vector — needs no likeness and runs everywhere.
 */
const FACE_VIDEO = resolve('.calibration/fixture/face.y4m');
const HAS_FACE = existsSync(FACE_VIDEO);

/**
 * The browser surfaces, in a browser.
 *
 * These pages are plain ES modules served as static files, which put them out
 * of vitest's reach: their state lives in the DOM and their inputs arrive over
 * fetch. The ledger alert went in unverified by anything but my own eyes, and
 * the resale resume before it had the same shape — code that only runs against
 * real infrastructure is code CI never sees.
 *
 * Each surface is pointed at its own origin so every `/v1/*` call is same-origin
 * and can be fulfilled by a route handler without CORS in the way. That keeps
 * the fixtures to one file each and no stub server.
 *
 * The camera is not faked. The fan app has a marked no-camera path — it derives
 * a stand-in vector from the identity id and says so on screen — so the journey
 * can be walked headlessly, and one of the tests below exists to make sure that
 * admission never goes quiet.
 */
export default defineConfig({
  testDir: './apps',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  // A test that only passes on the second attempt is a test that is telling you
  // something. Retries would hide it.
  retries: 0,
  forbidOnly: !!process.env['CI'],
  /*
   * A machine-readable copy in CI, so a later step can check that the projects
   * it means to run actually ran.
   *
   * A project whose testMatch stops matching runs nothing and reports success,
   * which looks exactly like passing. That has been the most expensive failure
   * mode in this repository — a green tick over a suite that had quietly turned
   * itself off — and it is cheap to rule out.
   */
  reporter: process.env['CI'] ? [['list'], ['json', { outputFile: 'playwright-report.json' }]] : 'list',
  use: {
    trace: process.env['CI'] ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The camera flags change what `getUserMedia` does, so the surfaces that
      // do not ask for one are kept on a plain browser.
      testIgnore: '**/face-capture.spec.ts',
    },
    {
      name: 'camera',
      testMatch: '**/face-capture.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['camera'],
        launchOptions: {
          args: [
            // A synthetic stream instead of hardware: a rolling pattern with no
            // face in it, which is exactly what the refusal tests need.
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            ...(HAS_FACE ? [`--use-file-for-fake-video-capture=${FACE_VIDEO}`] : []),
          ],
        },
      },
    },
  ],
  /*
   * Three static hosts, one per surface, on the ports they use everywhere else.
   *
   * Each is pointed at its own origin so the fixtures can fulfil `/v1/*` without
   * CORS in the way — these pages take their API from /config.js, which is the
   * same mechanism production uses, so nothing here is a special case.
   */
  webServer: [
    {
      command: 'node apps/console/serve.js',
      env: { REXELL_API: 'http://127.0.0.1:8110' },
      url: 'http://127.0.0.1:8110/config.js',
      reuseExistingServer: !process.env['CI'],
      stdout: 'ignore',
    },
    {
      command: 'node apps/fan/serve.js',
      env: { REXELL_API: 'http://127.0.0.1:8120' },
      url: 'http://127.0.0.1:8120/config.js',
      reuseExistingServer: !process.env['CI'],
      stdout: 'ignore',
    },
    {
      command: 'node apps/scanner/serve.js',
      env: { REXELL_API: 'http://127.0.0.1:8100' },
      url: 'http://127.0.0.1:8100/config.js',
      reuseExistingServer: !process.env['CI'],
      stdout: 'ignore',
    },
  ],
});
