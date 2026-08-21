// App-shell offline support (roadmap "Platform" phase — offline/cached gate
// scan mode). Deliberately narrow scope: only caches same-origin GET
// requests — the app's own JS/CSS/HTML/assets — so it never touches
// Supabase API calls (cross-origin `*.supabase.co`, and non-GET entirely).
// Those are handled at the app level instead (js/lib/offlineCache.js),
// which can express "this data is possibly stale, cached at 3:04pm" —
// something a raw HTTP cache can't. This file solves a different, narrower
// problem: the app failing to even load with zero signal.
//
// Strategy is network-first, falling back to cache: always prefer a fresh
// copy when there's a connection (so a deploy is picked up on the very next
// load, not stuck behind a stale cached bundle — this app already ships
// unhashed filenames with `Cache-Control: no-cache` for exactly that
// reason, see .htaccess); only serve from the cache when the network fetch
// actually fails.

const CACHE_NAME = 'fieldcred-shell-v4';

// Precached at install so a gate device that is rebooted with no signal can
// still boot the app, rather than depending on having happened to load every
// module while online. Deliberately just the boot path — everything else is
// picked up by the runtime caching below on first online use. Keeping this
// list short is what keeps it from rotting: this app has no build step, so
// nothing regenerates it automatically.
//
// './' and './index.html' are BOTH listed on purpose: they are separate cache
// keys, and which one a navigation matches depends on how the app was opened.
const PRECACHE_URLS = [
  './',
  './index.html',
  './css/styles.css',
  './manifest.webmanifest',
  './js/main.js',
  './js/pages/scan.js',
  './js/pages/gateApp.js',
  './js/pages/gateConfig.js',
  './js/pages/publicRecord.js',
  './js/lib/qrScanner.js',
  './js/lib/offlineCache.js',
  './js/lib/offlineSync.js',
  './js/lib/clearance.js',
  './js/lib/gateVerdict.js',
  './js/lib/gateSession.js',
  './js/vendor/jsqr.mjs',
  './js/vendor/supabase-js.js',
  './assets/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Individually, NOT cache.addAll: addAll is atomic, so one 404 (a
      // renamed file this list wasn't updated for) would reject the whole
      // install and leave the app with no service worker at all — strictly
      // worse than the partial cache we'd otherwise have.
      Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Cache lookup that tolerates a differing query string.
//
// This app is multi-tenant via `?tenant=slug` (js/lib/tenant.js), so the very
// same index.html is requested as '/', '/?tenant=acme', '/?tenant=globex', …
// Cache matching is exact by default, INCLUDING the query — so a device that
// cached '/?tenant=acme' online would miss the cache entirely when opened
// offline from the home screen as '/', and fail as if nothing were cached at
// all. Falling back to an ignoreSearch match fixes that, and is safe here
// because the query never changes which bytes the server returns for these
// static files — it's read client-side.
async function matchCached(request) {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(request)) || (await cache.match(request, { ignoreSearch: true })) || null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept writes/auth calls
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never intercept Supabase or any other cross-origin request

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Only cache real, successful, same-origin ("basic") responses —
        // never an opaque or error response, which would otherwise get
        // served back as if it were good.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await matchCached(req);
        if (cached) return cached;
        // A navigation we've never seen this exact URL for (a shared deep
        // link opened offline, say). The app is hash-routed, so the shell is
        // the same document for every route — serving it lets the router
        // handle the request client-side instead of showing the browser's
        // dead-dinosaur page.
        if (req.mode === 'navigate') {
          const shell = (await caches.match('./index.html')) || (await caches.match('./'));
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
