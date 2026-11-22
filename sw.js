// AcreFlow service worker: app files cached for fast launch and updated from the network; map tiles stay live.
const SHELL = 'acreflow-v4';
const FILES = ['./', 'index.html', 'app.js?v=4', 'engine.js?v=4', 'pdf-lib.min.js', 'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css',
  'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;   // tiles, elevation, search: always live
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(SHELL).then(ca => ca.put(e.request, c)); } return r; }).catch(() => caches.match(e.request)));
});
