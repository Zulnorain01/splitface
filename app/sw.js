/* ============================================================
   SplitFace — service worker: offline app shell cache.

   Caches the full client-side app (HTML/CSS/JS, fonts, the
   vendored MediaPipe engine, sample photos) on first visit so
   the page keeps working offline after the first load.
   Bump CACHE_NAME when shipping a new build.
   ============================================================ */

const CACHE_NAME = 'splitface-v2';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './vendor/fonts/fonts.css',
  './vendor/fonts/jakarta-italic-400800.woff2',
  './vendor/fonts/jakarta-normal-400800.woff2',
  './vendor/mediapipe/vision_bundle.mjs',
  './vendor/mediapipe/wasm/vision_wasm_internal.js',
  './vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js',
  './vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  './vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
  './vendor/mediapipe/blaze_face_short_range.tflite',
  './assets/sample-parent.jpg',
  './assets/sample-parent-thumb.jpg',
  './assets/sample-child.jpg',
  './assets/sample-child-thumb.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle same-origin GETs (the whole app is client-side).
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      // Cache-first for the shell; network fills anything new (e.g. future assets).
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
