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

/** Shared files every surface gets, copied in from @rexell/ui. */
const SHARED_ASSETS = ['ui.css', 'logo.svg', 'logo-lockup.svg', 'logo-lockup.png', 'logo-full.png'];

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
for (const asset of SHARED_ASSETS) {
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

/*
 * The three apps ship inside the site, under paths.
 *
 * Nothing links off to another origin, because a visitor who presses a button
 * and watches the domain change has been handed to somebody else's website —
 * and one of these is about to ask for their face. One origin, so there is
 * nothing to hand off, one certificate, and one config.js telling all four
 * surfaces where the API is.
 *
 * It costs almost nothing: ui.css, config.js and the logos sit at this root
 * and are shared rather than copied into each app.
 */
const MOUNTS = { fan: 'app', console: 'console', scanner: 'gate' };

if (surface === 'site') {
  for (const [app, path] of Object.entries(MOUNTS)) {
    const target = resolve(output, path);
    mkdirSync(target, { recursive: true });
    cpSync(resolve(root, SURFACES[app]), target, { recursive: true });
  }
  // Same-origin paths, so REXELL_FAN and REXELL_CONSOLE are no longer needed
  // — and an env var that can point the buttons somewhere wrong is one fewer
  // thing to get wrong.
  links.fan = '/app';
  links.console = '/console';
  links.scanner = '/gate';
}

writeFileSync(
  resolve(output, 'config.js'),
  `window.__REXELL_API__=${JSON.stringify(origin)};\nwindow.__REXELL_LINKS__=${JSON.stringify(links)};\n`,
);

if (CLIENT_ROUTED.has(surface)) {
  /*
   * Netlify serves a real file when one exists and falls through to these
   * rules when it does not, so the catch-all is what lets /fan-journey reach
   * the router after a reload.
   *
   * On its own that catch-all also answers a missing script or image with the
   * HTML shell and a 200, which is worse than a 404: the browser reports a
   * syntax error in a file that looks like it loaded, and nothing points at
   * the actual problem. Netlify's rules cannot match on file extension, so
   * the asset directories are excluded by name, first — order decides.
   */
  writeFileSync(
    resolve(output, '_redirects'),
    [
      // Real pages addressed without their extension, before the catch-all.
      // Netlify would otherwise answer /join with the marketing shell and a
      // 200 — the page appears to load, and is the wrong one.
      '/join              /join.html              200',
      '/assets/*          /assets/:splat          404',
      '/team/*            /team/:splat            404',
      // A mounted app has its own routing and is not part of this site's.
      // Without these, a missing file under one comes back as the marketing
      // page with a 200.
      ...Object.values(MOUNTS).map((path) => `/${path}/*`.padEnd(19) + `/${path}/:splat`.padEnd(24) + '404'),
      // The shared assets sit at the root rather than under /assets, so the
      // directory rules above do not cover them and a missing one would come
      // back as the HTML shell with a 200. That is not hypothetical: it is
      // how a failed deploy of this very logo first presented — the file was
      // absent and the page served itself in its place.
      ...SHARED_ASSETS.map((a) => `/${a}`.padEnd(19) + `/${a}`.padEnd(24) + '404'),
      '/*                 /index.html             200',
      '',
    ].join('\n'),
  );
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
