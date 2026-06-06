// Service worker — офлайн-кэш для PWA «Мои рецепты»
const CACHE = "recipes-v9";
const ASSETS = [
  "./",
  "index.html",
  "css/styles.css?v=9",
  "js/app.js?v=9",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // recipes.json — сначала сеть (чтобы видеть свежие рецепты), потом кэш
  if (url.pathname.endsWith("/data/recipes.json")) {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const cl = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cl)); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // остальное (включая картинки) — сначала кэш, потом сеть с дозаписью
  e.respondWith(
    caches.match(e.request).then((cached) =>
      cached ||
      fetch(e.request).then((r) => {
        if (r.ok && (url.pathname.includes("/images/") || url.origin === location.origin)) {
          const cl = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, cl));
        }
        return r;
      }).catch(() => cached)
    )
  );
});
