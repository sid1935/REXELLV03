/**
 * Static server for the gate scanner PWA.
 *
 *   npm run scanner
 *
 * Prints a provisioning URL. In a real deployment the config, the sealed
 * manifest and the key release all arrive through mobile device management;
 * this is that, done by hand for one lane.
 *
 * The server itself lives in @rexell/ui, shared with the fan app and the
 * console.
 */
import { fileURLToPath } from 'node:url';
import { staticServer } from '@rexell/ui/static-server';

const PORT = Number(process.env.SCANNER_PORT ?? 8100);
const API = process.env.REXELL_API ?? 'http://127.0.0.1:8080';
const EVENT = process.env.REXELL_EVENT ?? 'evt_sunburn26';

staticServer({
  root: fileURLToPath(new URL('./public', import.meta.url)),
  ui: fileURLToPath(new URL('../../packages/ui', import.meta.url)),
  port: PORT,
  apiOrigin: API,
  https: process.env.PUBLIC_HTTPS === 'true',
  host: process.env.SCANNER_HOST ?? '0.0.0.0',
  onReady: () => {
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
