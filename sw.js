/**
 * sw.js — TradeJournal Service Worker (minimal, bulletproof)
 * Only caches the app shell. Network-first for everything else.
 */
const CACHE = 'tj-shell-v2';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // Cache BOTH explicit paths so Chrome offline validation always succeeds
      .then(cache => cache.addAll(['/', '/index.html', '/manifest.json']))
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

  // Always network-first for Supabase API calls
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response('{}', { headers: { 'Content-Type': 'application/json' }}))
    );
    return;
  }

  // Network-first for navigation (HTML pages) - guarantees a 200 response
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          if (!resp.ok) throw new Error('Offline or 404');
          const clone = resp.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        if (resp && resp.status === 200 && event.request.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => new Response('', { status: 404 })); // Prevents unhandled promise rejection
    })
  );
});
