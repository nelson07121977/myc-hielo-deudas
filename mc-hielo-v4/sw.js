// GLACIAR v4 - Service Worker
// Solo cachea el shell (HTML/JS/CSS/manifest). NUNCA datos ni Firebase.

const CACHE = 'glaciar-v4-shell-1';
const CORE = ['./', './index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // NUNCA cachear Firebase, Google APIs, gstatic ni data/
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic') ||
    url.pathname.includes('/data/')
  ) {
    return;
  }

  // Navegación / HTML: network-first, fallback a cache
  if (
    e.request.mode === 'navigate' ||
    (e.request.headers.get('accept') || '').includes('text/html')
  ) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Resto: cache-first
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => r))
  );
});