// Starts-Agents service worker: cache the app shell so the installed
// PWA opens instantly (and offline shows the shell), but NEVER cache
// API traffic — chats, approvals and transcripts must stay live.
const CACHE = 'starts-agents-v2';
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
  if (e.request.mode === 'navigate') {
    // Page loads: network first (fresh UI), cache as offline fallback.
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
