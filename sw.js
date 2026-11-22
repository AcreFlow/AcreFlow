// Field Flow service worker: app shell + library cached for fast launch; map tiles stay live.
const SHELL = 'fieldflow-v1';
const FILES = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const local = u.origin === location.origin;
  const lib = u.hostname === 'unpkg.com' || u.hostname.endsWith('googleapis.com') || u.hostname.endsWith('gstatic.com');
  if (!local && !lib) return; // tiles, elevation, search: always live
  e.respondWith(
    local
      ? fetch(e.request).then(r => { const c = r.clone(); caches.open(SHELL).then(ca => ca.put(e.request, c)); return r; }).catch(() => caches.match(e.request))
      : caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { const c = r.clone(); caches.open(SHELL).then(ca => ca.put(e.request, c)); return r; }))
  );
});
