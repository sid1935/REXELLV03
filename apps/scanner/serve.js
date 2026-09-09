/**
 * Static server for the scanner PWA.
 *
 *   npm run scanner
 *
 * Prints a provisioning URL. In a real deployment the config, the sealed
 * manifest and the key release all arrive through mobile device management;
 * this is that, done by hand for one lane.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./public', import.meta.url));
const PORT = Number(process.env.SCANNER_PORT ?? 8100);
const API = process.env.REXELL_API ?? 'http://127.0.0.1:8080';
const EVENT = process.env.REXELL_EVENT ?? 'evt_sunburn26';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const file = join(ROOT, path === '/' ? 'index.html' : path.replace(/^\//, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // A cached scanner.js after a policy change is a lane running last week's rules.
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => {
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

  console.log(`\n  ReXell gate scanner on http://127.0.0.1:${PORT}`);
  console.log(`  API expected at ${API}, event ${EVENT}\n`);
  console.log(`  Provision lane 1:\n  http://127.0.0.1:${PORT}/?config=${config}\n`);
  console.log('  The camera needs localhost or https. Simulate works without one.\n');
});
