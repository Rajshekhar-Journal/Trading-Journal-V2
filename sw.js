/**
 * sw.js — TradeJournal Service Worker (minimal, bulletproof)
 * Only caches the app shell. Network-first for everything else.
 * A failing cache.addAll() kills SW install — keep the list tiny.
 */
const CACHE = 'tj-shell-v1';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(['/index.html', '/manifest.json']))
      .then(() => self.skipWaiting())
      .catch(e => { console.warn('[SW] Install cache failed:', e); self.skipWaiting(); })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always network-first for Supabase API calls (live data)
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(fetch(event.request).catch(() => new Response('{}', { headers: { 'Content-Type': 'application/json' }})));
    return;
  }

  // Network-first for navigation (HTML pages)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          const clone = resp.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for static assets (JS, CSS, images)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        if (resp && resp.status === 200 && event.request.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
