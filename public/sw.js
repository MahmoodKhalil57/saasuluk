/* saasuluk service worker — a minimal offline shell. Cache-first for static assets, network-first for
   navigations (so pages stay fresh), with a cached fallback when offline. Bump CACHE to invalidate. */
const CACHE = "saasuluk-v2"; // bump on every shell-affecting deploy → forces reinstall + purges the stale cached "/"
const SHELL = ["/", "/products", "/blogs", "/favicon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // never cache the API's writes
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // API/JSON paths: always go to the network (the contract is live).
  if (/^\/(api|cost|scalar|openapi|product|order|cart|review|post|faq|analytics|search|checkout|discount|recommendations|newsletter|tokens|avatar)/.test(url.pathname)) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || caches.match("/"))));
    return;
  }
  e.respondWith(caches.match(req).then((cached) => cached || fetch(req).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    return res;
  })));
});
