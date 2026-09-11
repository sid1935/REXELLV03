/**
 * The static server behind all three browser surfaces.
 *
 * This existed as three byte-identical copies, one per app, which is the drift
 * those files' own comments warn about for the stylesheet. It is one copy now,
 * and it does three things beyond reading files off disk:
 *
 *   /ui.css     serves the shared design system from this package
 *   /config.js  hands the page its API origin, chosen by the process
 *   headers     the small set that costs nothing
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, posix, resolve } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Headers applied to everything served.
 *
 * `frame-ancestors 'none'` matters more than it looks: the fan app asks for a
 * camera, and a camera prompt inside somebody else's iframe is a clickjacking
 * primitive.
 */
function securityHeaders({ apiOrigin, https, connect: extra = [] }) {
  // Extra origins exist for surfaces that are not ours end to end: the
  // marketing site is a built bundle that talks to its own Supabase project
  // for the waitlist, and a policy that silently broke that form would be
  // discovered by whoever stopped receiving sign-ups.
  const connect = ["'self'", apiOrigin, ...extra].filter(Boolean).join(' ');
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
    'content-security-policy': [
      "default-src 'none'",
      // No 'unsafe-inline' here, and no 'unsafe-eval'. Every surface loads its
      // logic from a file; nothing is built from a string at runtime.
      "script-src 'self'",
      // 'unsafe-inline' for styles only. All three pages carry a <style> block
      // and inline style attributes, and a style injection is a defacement
      // rather than code execution. Google Fonts serves the two faces.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      // data: for canvas output, blob: for the camera frame the fan app draws.
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      `connect-src ${connect}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    // Only meaningful over TLS, and a lie otherwise — so it is only sent when
    // the operator says TLS terminates in front of this.
    ...(https ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

/**
 * Start a surface.
 *
 * `apiOrigin` is baked into `/config.js` rather than read from the query string
 * by the page. The clients used to accept `?api=`, which meant a link could
 * point the fan app — including the enrolment step, where a face is captured —
 * at a server chosen by whoever wrote the link. The override survives for
 * localhost, where it is a development convenience and not a vector.
 */
export function staticServer({ root, ui, port, apiOrigin, links = {}, connect = [], spa = false, mount = {}, https = false, host = '0.0.0.0', onReady }) {
  const headers = securityHeaders({ apiOrigin, https, connect });
  /*
   * `links` is where the other surfaces live, for the pages that need to send
   * somebody to one — the marketing site's two calls to action, principally.
   * Same reasoning as the API origin: a surface is told where its siblings are
   * by the process that serves it, rather than guessing from the hostname or
   * taking it from a query string.
   */
  const config =
    `window.__REXELL_API__=${JSON.stringify(apiOrigin)};\n` +
    `window.__REXELL_LINKS__=${JSON.stringify(links)};\n`;

  return createServer(async (req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
    // posix.normalize, not normalize: on Windows the platform version rewrites
    // `/` to `\`, so every comparison against a URL path silently stops matching.
    const safe = posix.normalize(requested);

    if (safe === '/config.js') {
      res.writeHead(200, { ...headers, 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
      return void res.end(config);
    }

    /*
     * Another surface, served under a path of this one.
     *
     * The marketing site mounts the fan app at /app so that joining never
     * changes the address bar. A visitor who presses "Join as Fan" and lands
     * on a different domain has been handed off to somebody else's website,
     * whatever the design says — so there is no hand-off.
     */
    const mounted = Object.entries(mount).find(([prefix]) => safe === prefix || safe.startsWith(prefix + '/'));

    // The shared assets come from @rexell/ui; everything else from the app.
    const shared =
      ['/ui.css', '/logo.svg', '/logo-lockup.svg', '/logo-lockup.png'].includes(safe) ||
      // The event posters, which every surface addresses the same way.
      safe.startsWith('/events/');
    const base = shared
      ? ui
      : mounted
        ? mounted[1]
        : root;

    const withinMount = mounted ? safe.slice(mounted[0].length).replace(/^\/+/, '') : null;
    const relative =
      safe === '/' ? 'index.html' : mounted ? withinMount || 'index.html' : safe.replace(/^\/+/, '');
    const file = join(base, relative);
    // Resolved, then checked. A request must not be able to climb out of the
    // directory it is served from.
    if (!resolve(file).startsWith(resolve(base))) return void res.writeHead(403).end('forbidden');

    try {
      const body = await readFile(file);
      res.writeHead(200, {
        ...headers,
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        // A cached bundle after a policy change is a page running last week's rules.
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      /*
       * Client-routed surfaces hand unknown paths back to index.html, because
       * the router owns them: the marketing site's /fan-journey and /waitlist
       * exist only in the browser, and a reload or a pasted link on one of
       * them would otherwise 404 on a site that works perfectly when reached
       * by clicking.
       *
       * Only for extensionless paths. A missing script or image must still be
       * a 404 — answering those with HTML turns a broken asset into a parse
       * error somewhere else entirely.
       */
      /*
       * A plain page, addressed without its extension.
       *
       * Tried before the client-routing fallback, and that order is the whole
       * point: /join is a real file, but a catch-all that runs first answers
       * it with the site's shell and a 200, so the page looks like it loaded
       * and is simply the wrong one.
       */
      if (extname(relative) === '') {
        try {
          const page = await readFile(join(base, `${relative || 'index'}.html`));
          res.writeHead(200, { ...headers, 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
          return void res.end(page);
        } catch {
          // Not a page either; carry on to the fallback below.
        }
      }

      // A mounted app is not part of this surface's client routing, so a
      // missing file under it is a 404 rather than this site's shell.
      if (spa && !mounted && extname(relative) === '') {
        try {
          const shell = await readFile(join(root, 'index.html'));
          res.writeHead(200, { ...headers, 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
          return void res.end(shell);
        } catch {
          // Fall through to the 404 below.
        }
      }
      res.writeHead(404, headers).end('not found');
    }
  }).listen(port, host, onReady);
}
