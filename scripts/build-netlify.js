/**
 * Assemble one browser surface into `dist/` for a static host.
 *
 *   node scripts/build-netlify.js fan
 *   node scripts/build-netlify.js console
 *   node scripts/build-netlify.js scanner
 *
 * Netlify serves files and nothing else, so the two things `static-server.js`
 * does at request time have to happen here instead:
 *
 *   /config.js   written with the API origin, so no page takes it from a query
 *                string — a link with ?api=… would otherwise point enrolment,
 *                where a face is captured, at a server of the linker's choosing
 *   _headers     the security headers, generated rather than written into
 *                netlify.toml because the CSP has to name the API origin and
 *                netlify.toml cannot interpolate an environment variable
 *
 * Only the three browser surfaces can be hosted this way. The API and the
 * vault cannot: they are long-running processes with a SQLite database, one
 * writer, and background timers draining the chain outbox and the waiting
 * room. See docs/DEPLOYMENT.md for where those go.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SURFACES = {
  fan: 'apps/fan/public',
  console: 'apps/console/public',
  scanner: 'apps/scanner/public',
  site: 'apps/site/public',
};

/*
 * The marketing site is client-routed and its calls to action need to know
 * where the product lives, so it takes two things the other surfaces do not:
 * a redirects file, and the fan and console origins in its config.
 */
const CLIENT_ROUTED = new Set(['site']);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');

const surface = process.argv[2] ?? process.env.NETLIFY_SURFACE ?? 'fan';
if (!SURFACES[surface]) {
  console.error(`\n[build] Unknown surface ${JSON.stringify(surface)}.`);
  console.error(`[build] Expected one of: ${Object.keys(SURFACES).join(', ')}`);
  console.error('[build] Set NETLIFY_SURFACE in the site\'s environment, or pass it as an argument.\n');
  process.exit(78); // EX_CONFIG
}

/*
 * The API origin is required, and the build fails without it.
 *
 * A surface built with no API origin looks completely fine — it deploys, it
 * renders, the header and the navigation are all there — and then every call
 * falls back to http://127.0.0.1:8080, which on a visitor's phone is the
 * phone. Failing the build is the only way this gets noticed before somebody
 * tries to buy a ticket.
 */
const apiOrigin = process.env.REXELL_API ?? '';
if (!apiOrigin) {
  console.error('\n[build] REXELL_API is not set.');
  console.error('[build] It must be the public HTTPS origin of the API, e.g. https://api.example.com');
  console.error('[build] Set it under Site configuration → Environment variables.\n');
  process.exit(78);
}
if (!/^https:\/\//.test(apiOrigin) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(apiOrigin)) {
  // A page served over HTTPS cannot call a plaintext origin — the browser
  // blocks it as mixed content, silently as far as most users are concerned.
  console.error(`\n[build] REXELL_API is ${apiOrigin}, which is not https.`);
  console.error('[build] A page served over HTTPS cannot call a plaintext API; the browser blocks it.\n');
  process.exit(78);
}

const origin = apiOrigin.replace(/\/+$/, '');

rmSync(output, { force: true, recursive: true });
mkdirSync(output, { recursive: true });

cpSync(resolve(root, SURFACES[surface]), output, { recursive: true });
// The shared design system and the marks, which every surface loads from
// paths that `static-server.js` maps to @rexell/ui at request time.
for (const asset of ['ui.css', 'logo.svg', 'logo-lockup.svg', 'logo-full.png']) {
  cpSync(resolve(root, 'packages/ui', asset), resolve(output, asset));
}

/*
 * Where the sibling surfaces live.
 *
 * Only the marketing site uses these today — they are what its two calls to
 * action point at — but the same mechanism serves any page that has to send
 * somebody somewhere else in the product.
 */
const links = {
  ...(process.env.REXELL_FAN ? { fan: process.env.REXELL_FAN.replace(/\/+$/, '') } : {}),
  ...(process.env.REXELL_CONSOLE ? { console: process.env.REXELL_CONSOLE.replace(/\/+$/, '') } : {}),
};

if (surface === 'site' && (!links.fan || !links.console)) {
  // The buttons are the whole point of this surface. Built without anywhere
  // for them to go, it deploys looking perfect and does nothing when pressed.
  console.error('\n[build] The site surface needs REXELL_FAN and REXELL_CONSOLE.');
  console.error('[build] They are the public origins of the fan app and the organizer console,');
  console.error('[build] e.g. https://tickets.example.com and https://organizers.example.com\n');
  process.exit(78);
}

writeFileSync(
  resolve(output, 'config.js'),
  `window.__REXELL_API__=${JSON.stringify(origin)};\nwindow.__REXELL_LINKS__=${JSON.stringify(links)};\n`,
);

if (CLIENT_ROUTED.has(surface)) {
  // Netlify tries files first and falls through to this, so /fan-journey
  // reaches the router while a genuinely missing /assets/... still 404s.
  writeFileSync(resolve(output, '_redirects'), '/*  /index.html  200\n');
}

/*
 * Headers.
 *
 * Netlify terminates TLS, so unlike the Node server this one does assert HSTS
 * — here it is true rather than a guess.
 */
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  // 'unsafe-inline' for styles only: every page carries a <style> block and
  // inline style attributes, and a style injection is defacement rather than
  // code execution.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  // data: for canvas output, blob: for the camera frame the fan app draws.
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  // The marketing site is an imported bundle whose waitlist form posts to its
  // own Supabase project. Everything else talks only to our API.
  `connect-src 'self' ${origin}${surface === 'site' ? ' https://ofcchocnplwpfalqlvnv.supabase.co' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const headers = `# Generated by scripts/build-netlify.js — do not edit.
# The CSP names the API origin, which is why this is generated per build
# rather than written into netlify.toml.

/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: ${csp}

# A cached bundle after a policy change is a page running last week's rules.
/config.js
  Cache-Control: no-store

/*.js
  Cache-Control: no-cache

/*.html
  Cache-Control: no-cache
`;

writeFileSync(resolve(output, '_headers'), headers);

/*
 * The service worker must be allowed to control the whole origin.
 *
 * A worker served from /sw.js already has root scope, so no Service-Worker-
 * Allowed header is needed — but it must never be cached, or a gate device
 * keeps running the previous one after a deploy.
 */
if (surface === 'scanner') {
  writeFileSync(
    resolve(output, '_headers'),
    `${headers}\n/sw.js\n  Cache-Control: no-store\n`,
  );
}

console.log(`  surface   ${surface}`);
console.log(`  API       ${origin}`);
console.log(`  output    ${output}`);
