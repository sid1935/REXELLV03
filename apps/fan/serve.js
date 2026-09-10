/**
 * Static server for the fan app.
 *
 *   npm run fan
 *
 * The server itself lives in @rexell/ui, shared with the console and the
 * scanner — it serves the design system at /ui.css and the API origin at
 * /config.js, so no surface guesses either.
 */
import { fileURLToPath } from 'node:url';
import { staticServer } from '@rexell/ui/static-server';

const PORT = Number(process.env.FAN_PORT ?? 8120);
const API = process.env.REXELL_API ?? 'http://127.0.0.1:8080';

staticServer({
  root: fileURLToPath(new URL('./public', import.meta.url)),
  ui: fileURLToPath(new URL('../../packages/ui', import.meta.url)),
  port: PORT,
  apiOrigin: API,
  https: process.env.PUBLIC_HTTPS === 'true',
  host: process.env.FAN_HOST ?? '0.0.0.0',
  onReady: () => {
    console.log(`\n  ReXell fan app  http://127.0.0.1:${PORT}`);
    console.log(`  API             ${API}`);
    console.log(`  The camera needs localhost or https.\n`);
  },
});
