/* BG Swap service worker

   1. App files: always ask the network first (so every update reaches the phone on the next
      launch), and fall back to the saved copy when offline or the connection is very slow.
   2. AI engine + model: saved after the first download and reused from then on (their URLs
      never change), so it works offline and starts instantly.
   3. Adds the headers that let the AI use several CPU cores (GitHub Pages can't send them).

   Keep ENGINE_CACHE in sync with index.html. */

const SHELL_CACHE = 'bgswap-shell-v2';
const ENGINE_CACHE = 'bgswap-engine-imgly-1.7.0';
const SHELL_FILES = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];
const ENGINE_HOSTS = new Set(['cdn.jsdelivr.net', 'staticimgly.com']);
const SLOW_NETWORK_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL_FILES.map(async (file) => {
      try {
        const res = await fetch(new Request(file, { cache: 'reload' }));
        if (res.ok) await cache.put(file, res);
      } catch (err) { /* offline during install: the next online visit fills the cache */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ENGINE_CACHE]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // Never let a service-worker bug stop the app from loading: fall back to a plain fetch.
    event.respondWith(appFile(event).catch(() => fetch(req)));
  } else if (ENGINE_HOSTS.has(url.hostname)) {
    event.respondWith(engineFile(event).catch(() => fetch(req)));
  }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function appFile(event) {
  const req = event.request;
  const cache = await caches.open(SHELL_CACHE);

  // 'no-store' = always ask the server, never trust a copy in the browser's own cache (it can be up to 10
  // minutes old on GitHub Pages, and validators like Last-Modified only have 1-second precision).
  const network = fetch(req, { cache: 'no-store' }).then((res) => {
    if (res.ok && res.type === 'basic') event.waitUntil(cache.put(req.url, res.clone()).catch(() => {}));
    return res;
  });

  let res;
  try {
    res = await Promise.race([network, delay(SLOW_NETWORK_MS).then(() => { throw new Error('slow network'); })]);
  } catch (err) {
    const saved = (await cache.match(req.url, { ignoreSearch: true })) ||
      (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    if (saved) {
      event.waitUntil(network.catch(() => {})); // let a slow request finish and refresh the saved copy
      res = saved;
    } else {
      res = await network; // nothing saved yet: wait for the network (throws if offline)
    }
  }
  return withIsolationHeaders(res);
}

async function engineFile(event) {
  const req = event.request;
  const cache = await caches.open(ENGINE_CACHE);
  const saved = await cache.match(req, { ignoreVary: true });
  if (saved) return saved;

  const res = await fetch(req);
  if (res.ok && (res.type === 'cors' || res.type === 'basic')) {
    event.waitUntil(cache.put(req, res.clone()).catch(() => {})); // e.g. storage full: just skip saving
  }
  return res;
}

// Cross-origin isolation lets the AI engine run on several CPU cores at once.
function withIsolationHeaders(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect' || res.type === 'error') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
