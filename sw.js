'use strict';
// Tabbed PDF service worker: the app works offline after the first visit.
// Bump CACHE when shipping a change to any precached file.
const CACHE = 'tabbedpdf-v0-3';
const CORE = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'vendor/pdf-lib/pdf-lib.min.js',
  'vendor/fontkit/fontkit.umd.min.js',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/fonts/DejaVuSans.ttf',
  'icons/tabbed-pdf.svg',
  'icons/tabbed-pdf-32.png',
  'icons/tabbed-pdf-192.png',
  'icons/tabbed-pdf-512.png',
  'icons/tabbed-pdf-180.png',
  'icons/tabbed-pdf-16.png',
  'icons/tabbed-pdf.ico',
  'favicon.ico',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tabbedpdf-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// v0.3: the app page, script and styles come from the network first, so a new version shows on the next reload;
// the saved copy is used when offline. Libraries, fonts and icons stay cache-first.
const FRESH = new Set(['', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest']);
const scope = new URL(self.registration.scope);
function save(req, res) {
  if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
}
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const rel = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : url.pathname;
  if (req.mode === 'navigate' || FRESH.has(rel)) {
    const key = req.mode === 'navigate' ? new Request(new URL('index.html', scope)) : req;
    event.respondWith(
      fetch(req, { cache: 'no-store' }).then((res) => save(key, res))
        .catch(() => caches.match(key).then((hit) => hit || caches.match('index.html')))
    );
    return;
  }
  // Cache-first for everything else (cmaps and standard fonts are cached as they are used).
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => save(req, res)).catch(() => caches.match('index.html')))
  );
});
