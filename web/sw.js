/* Service worker: permite instalar la app y abrirla sin conexión. */
const VERSION = 'v1';
const SHELL = `aach-shell-${VERSION}`;
const RUNTIME = 'aach-runtime';
const FILES = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'manifest.webmanifest',
  'fonts/serif.woff2', 'fonts/sans.woff2', 'icons/logo-128.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('aach-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Catálogo: primero la red (para ver libros nuevos); sin conexión, la última copia.
  if (url.pathname.endsWith('/data/catalog.json')) {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(RUNTIME).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Portadas: primero la copia guardada.
  if (url.pathname.includes('/covers/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(RUNTIME).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // Resto: copia guardada al instante y actualización en segundo plano.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
