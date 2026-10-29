/* Service Worker - Hadir Wajah
 * Semua aset (termasuk pustaka AI dan model) dihos tempatan dan di-cache semasa install,
 * jadi aplikasi berfungsi sepenuhnya luar talian selepas larian pertama.
 * Tukar VERSION apabila anda mengemas kini mana-mana fail.
 */
const VERSION = 'v1.4.0';
const CACHE = `hadir-wajah-${VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './app-core.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './vendor/face-api.esm.js',
  './vendor/models/tiny_face_detector_model-weights_manifest.json',
  './vendor/models/tiny_face_detector_model.bin',
  './vendor/models/face_landmark_68_tiny_model-weights_manifest.json',
  './vendor/models/face_landmark_68_tiny_model.bin',
  './vendor/models/face_recognition_model-weights_manifest.json',
  './vendor/models/face_recognition_model.bin'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(PRECACHE.map(async (asset) => {
      try { await cache.add(asset); }
      catch (error) { console.warn('[PWA] Cache gagal:', asset, error); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google Sheet dll. tidak disentuh
  if (req.headers.has('range')) return;

  // Fail besar & tidak berubah (pustaka, model, ikon): cache-first
  if (url.pathname.includes('/vendor/') || url.pathname.includes('/icons/')) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // Selebihnya: stale-while-revalidate (navigasi jatuh balik ke index.html)
  event.respondWith(staleWhileRevalidate(req));
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) return cached;
  const res = await net;
  if (res) return res;
  if (req.mode === 'navigate') {
    const fallback = await cache.match('./index.html');
    if (fallback) return fallback;
  }
  return new Response('Luar talian dan tiada salinan cache.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
