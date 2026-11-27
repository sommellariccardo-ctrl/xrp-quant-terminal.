/* XRP Quant Terminal PWA Service Worker — build 0.9.1 */
const CACHE_NAME = 'xrp-quant-v091';
const CACHE_PREFIX = 'xrp-quant-';
const BASE = self.registration.scope;
const APP_FILES = [
  BASE,
  BASE + 'index.html',
  BASE + 'cockpit-core.js',
  BASE + 'manifest.webmanifest',
  BASE + 'icon-192.png',
  BASE + 'icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_FILES);
    // Activate the new worker without waiting for every old tab to close.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    // Take control of already-open Safari/PWA clients.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network-first: after a GitHub Pages deployment, the next navigation
  // receives the current app rather than a stale cached index.html.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const fallback = await cache.match(BASE) || await cache.match(BASE + 'index.html');
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});
