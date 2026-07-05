const CACHE_NAME = 'nabd-shell-v5';
const SHELL_FILES = [
  './manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never touch cross-origin requests (Binance, TradingEconomics, ForexFactory,
  // proxies, fonts, etc.) — always go straight to network.
  if(url.origin !== self.location.origin){
    return;
  }

  // For the HTML shell (index.html or the root), always try network FIRST
  // so app updates are picked up immediately. Only fall back to cache if
  // completely offline.
  const isHtmlRequest = event.request.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('.html');

  if(isHtmlRequest){
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Other same-origin static assets (manifest.json): cache-first is fine.
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
