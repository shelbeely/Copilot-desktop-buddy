/**
 * sw.js — Service worker (app-shell cache strategy)
 *
 * Caches the PWA shell files so the app loads instantly and can show a
 * "you're offline" state gracefully.  GitHub API calls always go to the
 * network — cached data is never served for API responses.
 */

const CACHE_NAME = 'copilot-buddy-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './ble.js',
  './poller.js',
  './heartbeat.js',
  './manifest.json',
  './icons/icon.svg',
];

// --------------------------------------------------------------------------
// Install — pre-cache the app shell
// --------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// --------------------------------------------------------------------------
// Activate — purge old caches
// --------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// --------------------------------------------------------------------------
// Fetch — network first for API calls, cache first for shell assets
// --------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always use the network for GitHub API requests
  if (url.hostname === 'api.github.com') {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // Shell assets: cache first, fall back to network
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
