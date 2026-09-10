/**
 * Static server for the gate scanner PWA.
 *
 *   npm run scanner
 *
 * Prints a provisioning URL. In a real deployment the config, the sealed
 * manifest and the key release all arrive through mobile device management;
 * this is that, done by hand for one lane.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./public', import.meta.url));
const EVENT = process.env.REXELL_EVENT ?? 'evt_sunburn26';
const UI = fileURLToPath(new URL('../../packages/ui', import.meta.url));
const PORT = Number(process.env.SCANNER_PORT ?? 8100);
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
    // In a real deployment the config, the sealed manifest and the key release
    // all arrive through mobile device management. This is that, by hand, for
    // one lane.
    const config = Buffer.from(
      JSON.stringify({
        apiBase: API,
        eventId: EVENT,
        scannerId: 'scn_lane_1',
        lane: 'lane_1',
        gateGroup: 'main',
        allowReentry: false,
      }),
    ).toString('base64');

    console.log(`\n  ReXell gate scanner  http://127.0.0.1:${PORT}`);
    console.log(`  API ${API} · event ${EVENT}\n`);
    console.log(`  Provision lane 1:\n  http://127.0.0.1:${PORT}/?config=${config}\n`);
    console.log('  The camera needs localhost or https. Simulate works without one.\n');
  },
});
