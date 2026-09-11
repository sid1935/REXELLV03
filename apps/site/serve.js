/**
 * Static server for the marketing site.
 *
 *   npm run site
 *
 * The site itself is a built React bundle imported from the previous
 * deployment; there is no source for it here. What this repository adds is
 * /config.js, which tells the page where the fan app and the console live,
 * and /join.js, which sends the two calls to action there.
 */
import { fileURLToPath } from 'node:url';
import { staticServer } from '@rexell/ui/static-server';

const PORT = Number(process.env.SITE_PORT ?? 8140);
const API = process.env.REXELL_API ?? 'http://127.0.0.1:8080';
// Every app under a path of this site rather than at its own origin, so
// nothing the product does ever changes the address bar.
const MOUNTS = { '/app': 'fan', '/console': 'console', '/gate': 'scanner' };

staticServer({
  root: fileURLToPath(new URL('./public', import.meta.url)),
  ui: fileURLToPath(new URL('../../packages/ui', import.meta.url)),
  port: PORT,
  apiOrigin: API,
  links: { fan: '/app', console: '/console', scanner: '/gate' },
  mount: Object.fromEntries(
    Object.entries(MOUNTS).map(([at, app]) => [at, fileURLToPath(new URL(`../${app}/public`, import.meta.url))]),
  ),
  // The bundle's waitlist form posts to the Supabase project it was built
  // against. Blocking it would break sign-ups quietly.
  connect: ['https://ofcchocnplwpfalqlvnv.supabase.co'],
  // React Router owns /waitlist, /fan-journey, /organizer-journey and /admin.
  spa: true,
  https: process.env.PUBLIC_HTTPS === 'true',
  host: process.env.SITE_HOST ?? '0.0.0.0',
  onReady: () => {
    console.log(`\n  ReXell site  http://127.0.0.1:${PORT}`);
    console.log('  Join as Fan       → /join → /app/#start');
    console.log('  Join as Organizer → /console/#join');
    console.log('  Gate scanner      → /gate/\n');
  },
});
