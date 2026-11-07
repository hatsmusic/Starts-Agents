// Complay Ai service worker: keep the installed PWA fresh first,
// cached second. Shell assets are NETWORK-FIRST (falling back to the
// cache only when offline) — a cache-first shell once served an old
// stylesheet against a new page after an upgrade and blew the layout
// up. API traffic is never touched: chats and approvals stay live.
const CACHE = 'starts-agents-v4';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/i18n.js', '/manifest.webmanifest', '/icon.png', '/complay-c.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // live only, never cached
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});
