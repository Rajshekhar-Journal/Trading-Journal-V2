/**
 * sw.js — TradeJournal Service Worker
 * Strategy: Cache-first for static assets, network-first for API calls.
 * Offline: serve cached app shell silently.
 */
const CACHE_NAME = 'tj-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/login.html',
  '/css/style.css',
  '/css/components.css',
  '/css/modules.css',
  '/css/mobile.css',
  '/js/app.js',
  '/js/auth.js',
  '/js/calc.js',
  '/js/db-cloud.js',
  '/js/alerts.js',
  '/js/mobile.js',
  '/js/modules/dashboard.js',
  '/js/modules/positions.js',
  '/js/modules/watchlist.js',
  '/js/modules/paper-trades.js',
  '/js/modules/trades.js',
  '/js/modules/analytics.js',
  '/js/modules/capital.js',
  '/js/modules/playbook.js',
  '/js/modules/settings.js',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json'
];

// Install: cache all static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go network-first for Supabase API calls
  if (url.hostname.includes('supabase.co') || url.hostname.includes('googleapis')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
