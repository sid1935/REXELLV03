/**
 * Offline shell.
 *
 * The scanner must boot with no network at all — a lane whose device restarts
 * mid-event cannot wait for a venue's collapsed cellular to serve it an HTML
 * file. The manifest and queue live in localStorage; this caches the app itself.
 *
 * Two tiers, and the split matters.
 *
 * The shell is four small files and `install` fails if any of them is missing,
 * because an app that half-installed is worse than one that did not.
 *
 * The matcher is about eight megabytes — the library and three sets of network
 * weights — and it is cached after activation rather than during install. It
 * must be cached: without it a lane that restarts offline comes up with a
 * working interface that cannot recognise anybody, which is the failure this
 * whole file exists to prevent. But it must not block install, because a device
 * being set up on a venue's wifi should get a working app now and the weights a
 * few seconds later, not a failed registration and no app at all.
 */
const CACHE = 'rexell-gate-v2';

const SHELL = ['./', './index.html', './scanner.js', './manifest.webmanifest'];

/*
 * Absolute paths, because the matcher is shared from @rexell/ui and is served
 * at the origin root — `/face/...` — while this scanner is mounted under a path
 * like `/gate/`. A relative './face/...' would resolve inside the mount and
 * cache four 404s.
 */
const MATCHER = [
  '/face-capture.js',
  '/face/face-api.js',
  '/face/models/tiny_face_detector_model-weights_manifest.json',
  '/face/models/tiny_face_detector_model.bin',
  '/face/models/face_landmark_68_tiny_model-weights_manifest.json',
  '/face/models/face_landmark_68_tiny_model.bin',
  '/face/models/face_recognition_model-weights_manifest.json',
  '/face/models/face_recognition_model.bin',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(async () => {
        // One at a time and individually forgiving: a single missing weight
        // file should leave the other seven cached, not abandon the lot.
        const cache = await caches.open(CACHE);
        for (const url of MATCHER) {
          try {
            if (!(await cache.match(url))) await cache.add(url);
          } catch {
            /* retried on the next activation */
          }
        }
      }),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API calls are never cached. A stale delta response would be worse than no
  // response: the lane would believe it is current when it is not.
  if (url.pathname.startsWith('/v1/')) return;
  e.respondWith(caches.match(e.request).then((hit) => hit ?? fetch(e.request)));
});
