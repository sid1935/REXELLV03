import { defineConfig, devices } from '@playwright/test';

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
  reporter: 'list',
  use: {
    trace: process.env['CI'] ? 'retain-on-failure' : 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
