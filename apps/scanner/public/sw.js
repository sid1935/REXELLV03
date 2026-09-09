/**
 * Offline shell.
 *
 * The scanner must boot with no network at all — a lane whose device restarts
 * mid-event cannot wait for a venue's collapsed cellular to serve it an HTML
 * file. The manifest and queue live in localStorage; this caches the app itself.
 */
const CACHE = 'rexell-gate-v1';
const SHELL = ['./', './index.html', './scanner.js', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API calls are never cached. A stale delta response would be worse than no
  // response: the lane would believe it is current when it is not.
  if (url.pathname.startsWith('/v1/')) return;
  e.respondWith(caches.match(e.request).then((hit) => hit ?? fetch(e.request)));
});
