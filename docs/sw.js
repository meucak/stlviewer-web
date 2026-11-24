const CACHE_NAME = 'stlviewer-web-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './favicon.svg',
  './manifest.webmanifest',
  './icons/stlviewer.svg',
  './js/app.js',
  './js/camera.js',
  './js/culling.js',
  './js/demo_models.js',
  './js/i18n.js',
  './js/matcap.js',
  './js/math3d.js',
  './js/picking.js',
  './js/print_calc.js',
  './js/qr_encoder.js',
  './js/renderer.js',
  './js/renderer_canvas2d.js',
  './js/renderer_webgl1.js',
  './js/share_state.js',
  './js/stl_parser.js',
  './js/stl_worker.js',
  './js/vault.js',
  './js/zip_stl.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Handle Android / PWA Web Share Target POST with an STL file
  if (req.method === 'POST' && url.searchParams.has('shared_target')) {
    event.respondWith(
      (async () => {
        try {
          const form = await req.formData();
          const file = form.get('stl_file');
          const sharedUrl = form.get('url') || form.get('text');
          if (file && typeof file.arrayBuffer === 'function') {
            const cache = await caches.open('stlviewer-share-inbox');
            await cache.put(
              '/__shared_stl__',
              new Response(await file.arrayBuffer(), {
                headers: { 'X-File-Name': encodeURIComponent(file.name || 'shared.stl') },
              })
            );
            return Response.redirect('./?from_share_target=1', 303);
          }
          if (sharedUrl && /^https?:\/\//i.test(String(sharedUrl).trim())) {
            return Response.redirect(`./?url=${encodeURIComponent(String(sharedUrl).trim())}`, 303);
          }
        } catch {}
        return Response.redirect('./', 303);
      })()
    );
    return;
  }

  if (req.method !== 'GET') return;

  // Never cache dynamic backend API or shared model routes
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/')) {
    return;
  }

  // Network-first with offline cache fallback for same-origin static assets
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
  }
});
