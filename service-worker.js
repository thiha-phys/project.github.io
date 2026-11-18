const CACHE_NAME = 'mandalay-physics-group-2-v27';
const APP_FILES = [
  './tnp.css',
  './cmp.css',
  './welcome.css',
  './welcome.js',
  './pwa.js',
  './subject.css',
  './electronic.css',
  './category.css',
  './electronic.js',
  './account.css',
  './account.js',
  './account-ui.css',
  './account-ui.js',
  './bridge.js',
  './manifest.webmanifest',
  './assets/mandalay-campus.jpg',
  './logo.png',
  './logo-192.png',
  './unilogo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin || requestUrl.pathname.includes('/api/')) return;
  if (event.request.mode === 'navigate') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
