/* TERRA client service worker: precache the app shell, serve cache-first. */
importScripts('version.js');

const CACHE = `terra-client-${self.TERRA_VERSION}`;

// The app shell, so the installed app opens fast and without the network.
// Job data is never cached: it is read live from the API. Add new files here.
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './version.js',
  './css/app.css',
  './css/current-job.css',
  './css/lookup.css',
  './css/shipping.css',
  './css/mobile.css',
  './css/print.css',
  './js/api.js',
  './js/app.js',
  './js/current-job.js',
  './js/export.js',
  './js/hold.js',
  './js/lookup.js',
  './js/lookup-ui.js',
  './js/mobile.js',
  './js/parts.js',
  './js/pf-loads.js',
  './js/scanner.js',
  './js/server-ui.js',
  './js/shipping.js',
  './js/shipping-ui.js',
  './js/updater.js',
  './js/vendor/jsQR.js',
  './js/vendor/qrcode.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('terra-client-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The version check must always hit the network so updates are seen.
  if (url.searchParams.has('versioncheck')) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() => {
        // Offline navigation to an uncached URL: fall back to the app shell.
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
