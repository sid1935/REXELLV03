/**
 * Static server for the organizer console.
 *
 *   npm run console
 *
 * It serves three files and nothing else. Every call the page makes is one an
 * organizer could make with curl — if this page can do something the public API
 * cannot, the API is incomplete.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./public', import.meta.url));
const PORT = Number(process.env.CONSOLE_PORT ?? 8110);
const API = process.env.REXELL_API ?? 'http://127.0.0.1:8080';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const file = join(ROOT, path === '/' ? 'index.html' : path.replace(/^\//, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => {
  console.log(`\n  ReXell organizer console on http://127.0.0.1:${PORT}/?api=${API}`);
  console.log(`  Start the API first:  npm run dev\n`);
});
