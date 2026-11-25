/* EscolarGo · service worker: instalación como app y notificaciones push */
const CACHE = 'escolargo-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/icon.svg', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// La API siempre va a la red; la interfaz usa red primero y caché si no hay señal.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'EscolarGo', body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible')) return; // la app abierta ya muestra el aviso
    await self.registration.showNotification(d.title || 'EscolarGo', {
      body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: d.tag, renotify: !!d.tag,
      vibrate: d.kind === 'panico' ? [400, 200, 400, 200, 400] : [120, 60, 120],
    });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((ws) => (ws.length ? ws[0].focus() : self.clients.openWindow('/'))));
});
