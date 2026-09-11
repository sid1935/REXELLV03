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
 *
 * ⚠ Fetch strategy, and this file got it wrong in a way that took a live test to
 * find. Everything used to be cache-first with no revalidation, so a lane served
 * whatever it had cached forever and could never be updated. A change to the
 * attestation format shipped, the server moved to it, and the lane went on
 * signing the old one from cache — every decision it filed was rejected as
 * BAD_SIGNATURE, and the audit trail for the night was empty. A gate that cannot
 * be updated is not a cache strategy, it is a liability.
 */
const CACHE = 'rexell-gate-v3';

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

/** The weights, by path. Immutable for the life of a model, and enormous. */
const isModel = (url) => url.pathname.startsWith('/face/');

self.addEventListener('install', (e) => {
  // `reload` bypasses the HTTP cache as well, so an install cannot pick up a
  // stale copy from the layer underneath this one.
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
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
  if (e.request.method !== 'GET') return;

  // The model weights: cache-first, because they are tens of megabytes and do
  // not change without the filename changing.
  if (isModel(url)) {
    e.respondWith(caches.match(e.request).then((hit) => hit ?? fetchAndStore(e.request)));
    return;
  }

  /*
   * Everything else — the lane's own code — is network-first.
   *
   * Online, the lane runs what the server is serving, so a fix reaches the door
   * on the next reload. Offline, it falls back to the cache and boots exactly as
   * before. The cost is one conditional request per file on a network that is
   * working; the alternative is a lane running code nobody can replace.
   */
  e.respondWith(fetchAndStore(e.request).catch(() => caches.match(e.request).then((hit) => hit ?? Response.error())));
});

async function fetchAndStore(request) {
  const response = await fetch(request);
  // Only cache what came back whole. An opaque or errored response written into
  // the cache is a lane that boots broken and stays broken.
  if (response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}
