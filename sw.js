'use strict';

const CACHE_NAME = 'gold-tracker-v1';

// App shell — everything needed to render the UI offline
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/icon.svg',
  '/icon-maskable.svg',
  '/manifest.json',
];

// Pre-cache the app shell on first install
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

// Remove old caches when a new SW version activates
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Let cross-origin requests (APIs, Chart.js CDN) go straight to network.
  // Price data is already cached in localStorage by app.js — no need to
  // duplicate that in the SW cache.
  if (!e.request.url.startsWith(self.location.origin)) return;

  // Cache-first for same-origin app shell files
  e.respondWith(
    caches.match(e.request).then(
      (cached) => cached || fetch(e.request)
    )
  );
});
