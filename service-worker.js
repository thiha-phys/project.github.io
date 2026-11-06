const CACHE_NAME = 'mandalay-physics-group-2-v19';
const APP_FILES = [
  './',
  './index.html',
  './electronic.html',
  './circuit-diagram.html',
  './ENP.html',
  './TNP.html',
  './tnp.css',
  './CMP.html',
  './cmp.css',
  './welcome.css',
  './welcome.js',
  './subject.css',
  './electronic.css',
  './category.css',
  './electronic.js',
  './manifest.webmanifest',
  './assets/mandalay-campus.jpg',
  './logo.png',
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
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return response;
    }).catch(async () => (await caches.match(event.request)) || caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
