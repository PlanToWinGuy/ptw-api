// Plan To Win service worker.
// Goal: make the app installable and open instantly (even offline) WITHOUT ever serving
// stale user data. The whole app is a single shell document (index.html) plus static
// font/icon assets; all real data comes from the ptw-api origin at request time.
//
// Strategy:
//  - App shell (same-origin navigations): network-first, fall back to the cached shell
//    when offline -- so an online launch always gets the latest deploy, but the app still
//    opens on the subway.
//  - Static assets (fonts, icons, same-origin css/js/img): cache-first (they're
//    immutable enough that speed beats freshness).
//  - Everything else, above all the API origin: NOT touched -- passes straight through to
//    the network so a logged meal or a fetched schedule is never a cached lie.
const VERSION = 'ptw-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const SHELL_URL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.add(SHELL_URL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isStaticAsset(url) {
  return /\.(?:woff2?|ttf|otf|png|jpg|jpeg|svg|webp|ico|css|js)$/i.test(url.pathname)
    || url.hostname.includes('fonts.gstatic.com')
    || url.hostname.includes('fonts.googleapis.com');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never cache mutations

  const url = new URL(req.url);

  // API traffic (any ptw-api / vercel API origin) is always live -- do not intercept.
  if (url.hostname.includes('ptw-api') || url.pathname.startsWith('/api/')) return;

  // App shell: network-first so a fresh deploy is picked up when online.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(SHELL_URL, copy));
        return res;
      }).catch(() => caches.match(SHELL_URL).then((r) => r || caches.match(req)))
    );
    return;
  }

  // Static assets: cache-first, then populate on miss.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(ASSET_CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached))
    );
  }
});
