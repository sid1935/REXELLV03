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
 * The console is pointed at its own origin so every `/v1/*` call is same-origin
 * and can be fulfilled by a route handler without CORS in the way. That keeps
 * the fixture to one file and no stub server.
 */
export default defineConfig({
  testDir: './apps/console/test',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  // A test that only passes on the second attempt is a test that is telling you
  // something. Retries would hide it.
  retries: 0,
  forbidOnly: !!process.env['CI'],
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8110',
    trace: process.env['CI'] ? 'retain-on-failure' : 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node apps/console/serve.js',
    // Its own origin, so the fixtures below need no CORS headers.
    env: { REXELL_API: 'http://127.0.0.1:8110' },
    url: 'http://127.0.0.1:8110/config.js',
    reuseExistingServer: !process.env['CI'],
    stdout: 'ignore',
  },
});
