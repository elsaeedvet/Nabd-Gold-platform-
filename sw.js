const CACHE_NAME = 'nabd-shell-v7';
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

/* ===================== Shared notification inbox (IndexedDB) ===================== */
// Every notification we show gets a record here BEFORE it's displayed, so:
//   1. Tapping it can tell the open app "open notification X" instead of just going blank.
//   2. If the user swipes it away from the OS tray without tapping, it's not lost — it's
//      still sitting in the in-app "صندوق الإشعارات" (notification inbox) list.
//   3. Records older than 48h are purged automatically (see NOTIF_RETENTION_MS).
const NOTIF_DB_NAME = 'nabd-db';
const NOTIF_STORE = 'notifications';
const NOTIF_RETENTION_MS = 48 * 3600 * 1000;

function openNotifDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NOTIF_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(NOTIF_STORE)){
        db.createObjectStore(NOTIF_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveNotifRecord(record){
  try{
    const db = await openNotifDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(NOTIF_STORE, 'readwrite');
      tx.objectStore(NOTIF_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    // opportunistic cleanup of anything past the 48h retention window
    const cutoff = Date.now() - NOTIF_RETENTION_MS;
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(NOTIF_STORE, 'readonly');
      const req = tx.objectStore(NOTIF_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const stale = all.filter(r => r.createdAt < cutoff);
    if(stale.length){
      const tx = db.transaction(NOTIF_STORE, 'readwrite');
      stale.forEach(r => tx.objectStore(NOTIF_STORE).delete(r.id));
    }
  }catch(e){ /* IndexedDB failures shouldn't block showing the notification itself */ }
}

/* ===================== Real Web Push (from the نبض backend server) ===================== */
// The backend server sends payloads shaped like:
//   { title, body, tag, requireInteraction?, ...anything else }
// via web-push's sendNotification(). This just unwraps that and shows it — the actual
// entry/exit/reinforce/hedge/calendar decision logic all lives server-side.
self.addEventListener('push', event => {
  let payload = { title: '🔔 نبض', body: 'تحديث جديد' };
  try{
    if(event.data) payload = event.data.json();
  }catch(e){
    if(event.data) payload.body = event.data.text();
  }

  const { title, body, tag, requireInteraction, ...rest } = payload;
  const id = (tag || 'notif') + '-' + Date.now();
  const record = { id, title: title || '🔔 نبض', body: body || '', tag: tag || null, createdAt: Date.now(), read: false, extra: rest };

  event.waitUntil(
    saveNotifRecord(record).then(() =>
      self.registration.showNotification(record.title, {
        body: record.body,
        tag: tag || undefined,
        requireInteraction: Boolean(requireInteraction),
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        data: { id },
      }).catch(() => {
        // icons/icon-192.png may not exist in every deployment — retry with no icon rather
        // than silently dropping the notification.
        return self.registration.showNotification(record.title, {
          body: record.body, tag: tag || undefined, requireInteraction: Boolean(requireInteraction), data: { id },
        });
      })
    )
  );
});

// Tapping the notification opens/focuses the app AND tells it exactly which notification
// to show details for — either live via postMessage (app already open) or via a URL param
// the page reads on load (app was fully closed).
self.addEventListener('notificationclick', event => {
  const id = event.notification.data && event.notification.data.id;
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for(const client of clientList){
        if('focus' in client){
          client.postMessage({ type: 'nabd-open-notif', id });
          return client.focus();
        }
      }
      if(self.clients.openWindow) return self.clients.openWindow('./?openNotif=' + encodeURIComponent(id || ''));
    })
  );
});
