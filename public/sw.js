// Complay Ai service worker: keep the installed PWA fresh first,
// cached second. Shell assets are NETWORK-FIRST (falling back to the
// cache only when offline) — a cache-first shell once served an old
// stylesheet against a new page after an upgrade and blew the layout
// up. API traffic is never touched: chats and approvals stay live.
//
// Freshness belt-and-braces (learned the hard way): Cloudflare puts a
// 4-hour max-age on these files, which overrides the origin's
// no-cache and can pin a phone to a days-old app.js. So (1) the shell
// files carry a version query (?v=121 — bump it together with CACHE on
// every release; a new URL is a new cache entry everywhere), and
// (2) fetches here bypass the HTTP cache entirely.
const CACHE = 'starts-agents-v15';
const SHELL = ['/', '/index.html', '/style.css?v=121', '/app.js?v=121', '/i18n.js?v=121', '/manifest.webmanifest', '/icon.png', '/complay-c.svg?v=121'];

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
    fetch(e.request, { cache: 'no-store' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});
