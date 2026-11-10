// Bot Work service worker: keep the installed PWA fresh first,
// cached second. Shell assets are NETWORK-FIRST (falling back to the
// cache only when offline) — a cache-first shell once served an old
// stylesheet against a new page after an upgrade and blew the layout
// up. API traffic is never touched: chats and approvals stay live.
//
// Freshness belt-and-braces (learned the hard way): Cloudflare puts a
// 4-hour max-age on these files, which overrides the origin's
// no-cache and can pin a phone to a days-old app.js. So (1) the shell
// files carry a version query (?v=200 — bump it together with CACHE on
// every release; a new URL is a new cache entry everywhere), and
// (2) fetches here bypass the HTTP cache entirely.
//
// Cache discipline (v0.15.2, audit FE P2-4): only the app shell and
// its same-origin static assets are ever stored, and only on a
// successful (res.ok) response. Server-rendered surfaces — the /s/
// share landings above all — are NEVER cached and never answered
// with the app shell; an offline share link is simply offline.
const CACHE = 'starts-agents-v39';
const SHELL = ['/', '/index.html', '/style.css?v=200', '/app.js?v=200', '/i18n.js?v=200', '/ui-utils.js?v=200', '/shell200.js?v=200', '/manifest.webmanifest', '/icon.png', '/icon-192.png', '/icon-maskable-512.png', '/favicon-32.png', '/favicon-16.png', '/botwork-logo.png?v=200'];
const SHELL_PATHS = new Set(['/', '/index.html', '/style.css', '/app.js', '/i18n.js', '/ui-utils.js', '/shell200.js', '/manifest.webmanifest', '/icon.png', '/icon-192.png', '/icon-maskable-512.png', '/favicon-32.png', '/favicon-16.png', '/botwork-logo.png', '/sw.js']);

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
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // live only, never cached
  if (e.request.method !== 'GET') return;
  // Per-language i18n packs (item 122) are shell assets too —
  // network-first like the rest, cached under their own
  // language-carrying URL.
  if (!SHELL_PATHS.has(url.pathname) && !/^\/i18n-pack-[a-z]{2}\.js$/.test(url.pathname)) return; // /s/ shares and everything else: straight to network, never stored
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('/index.html') : undefined)))
  );
});
