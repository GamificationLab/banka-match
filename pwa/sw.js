// Офлайн: оболочка из кеша, база и разборы сеть-сначала (PRD раздел 13).
const CACHE = 'banka-32edf85bb7';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest',
  '../shared/verdict.js', '../shared/recognize.js', '../shared/resolve-inci.js', '../shared/base.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // База: сеть сначала, кеш как запас, чтобы обновления доезжали мгновенно.
  if (url.pathname.endsWith('/shared/base.json')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // Остальное: кеш сначала, сеть как запас.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }))
  );
});
