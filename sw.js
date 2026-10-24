// Offline support: app shell is cached up front; Quran page data and fonts are
// cached as they are read so previously opened pages work without a connection.
const SHELL = "mushaf-shell-v3";
const DATA = "mushaf-data-v3";
const SHELL_FILES = ["./", "index.html", "styles.css", "app.js", "data.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isData = (url) =>
  url.hostname === "api.quran.com" ||
  url.hostname === "cdn.jsdelivr.net" ||
  url.hostname === "api.alquran.cloud" ||
  url.hostname === "fonts.googleapis.com" ||
  url.hostname === "fonts.gstatic.com";

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  if (url.origin === location.origin) {
    // Network first for the shell so updates show up, cache as fallback.
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
    );
    return;
  }

  if (isData(url)) {
    // Stale-while-revalidate for Quran text and fonts.
    e.respondWith(
      caches.open(DATA).then(async (cache) => {
        const cached = await cache.match(e.request);
        const network = fetch(e.request)
          .then((res) => { if (res.ok || res.type === "opaque") cache.put(e.request, res.clone()); return res; })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
