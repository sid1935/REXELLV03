/**
 * Static server for the fan app.
 *
 *   npm run fan
 *
 * Serves the shared design system from packages/ui at /ui.css, so the fan app,
 * the console and the scanner all render from one stylesheet rather than three
 * copies that drift.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./public', import.meta.url));
const UI = fileURLToPath(new URL('../../packages/ui', import.meta.url));
const PORT = Number(process.env.FAN_PORT ?? 8120);
const API = process.env.REXELL_API ?? 'http://127.0.0.1:8080';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function staticServer({ root, ui, port, onReady }) {
  return createServer(async (req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
    // posix.normalize, not normalize: on Windows the platform version rewrites
    // `/` to `\`, so every comparison against a URL path silently stops matching.
    const safe = posix.normalize(requested);
    const base = safe === '/ui.css' ? ui : root;
    const relative = safe === '/' ? 'index.html' : safe.replace(/^\/+/, '');
    const file = join(base, relative);
    // Resolved, then checked. A request must not be able to climb out of the
    // directory it is served from.
    if (!resolve(file).startsWith(resolve(base))) return void res.writeHead(403).end('forbidden');

    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        // A cached bundle after a policy change is a page running last week's rules.
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  }).listen(port, onReady);
}

staticServer({
  root: ROOT,
  ui: UI,
  port: PORT,
  onReady: () => {
    console.log(`\n  ReXell fan app  http://127.0.0.1:${PORT}/?api=${API}`);
    console.log(`  The camera needs localhost or https.\n`);
  },
});
