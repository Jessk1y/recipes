// Service worker — офлайн-кэш для PWA «Мои рецепты»
const CACHE = "recipes-v18";
const IMG_CACHE = "recipes-img-v1"; // фото рецептов — переживают смену версии
// ES-модули импортируются без ?v, поэтому при смене версии все файлы скачиваются заново
// мимо HTTP-кэша (cache: "reload"). Новый модуль в js/ — добавить сюда.
const ASSETS = [
  "./",
  "index.html",
  "css/styles.css?v=18",
  "js/main.js?v=18",
  "js/config.js",
  "js/core/storage.js",
  "js/core/serverConfig.js",
  "js/core/store.js",
  "js/core/ops.js",
  "js/core/actions.js",
  "js/api/client.js",
  "js/api/endpoints.js",
  "js/sync/catalog.js",
  "js/sync/sync.js",
  "js/lib/utils.js",
  "js/views/ui.js",
  "js/views/list.js",
  "js/views/detail.js",
  "js/views/shopping.js",
  "js/views/timers.js",
  "js/views/wake.js",
  "js/views/theme.js",
  "js/views/account.js",
  "js/views/admin.js",
  "js/views/recipeForm.js",
  "js/views/submissions.js",
  "data/recipes.json",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== IMG_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Клик по уведомлению таймера — открыть/сфокусировать приложение
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});

// Фото с другого домена (Cloudinary, /uploads API): сначала кэш, потом сеть.
// Пробуем CORS-запрос (нормальный ответ занимает в кэше реальный размер), иначе — обычный no-cors.
function imageFromCacheOrNet(req) {
  return caches.open(IMG_CACHE).then((cache) =>
    cache.match(req.url).then((cached) =>
      cached ||
      fetch(req.url, { mode: "cors", credentials: "omit" })
        .catch(() => fetch(req))
        .then((r) => {
          if (r.ok || r.type === "opaque") cache.put(req.url, r.clone());
          return r;
        })
        .catch(() => cached)
    )
  );
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  if (url.origin !== location.origin) {
    // API (каталог, синхронизация, вход) — всегда напрямую в сеть, офлайн-логика в самом приложении
    if (e.request.destination === "image") e.respondWith(imageFromCacheOrNet(e.request));
    return;
  }

  // HTML/навигация и recipes.json — сначала сеть (чтобы всегда была свежая
  // версия), при отсутствии сети — из кэша. Это чинит «залипание» старой версии.
  const isHTML = e.request.mode === "navigate" ||
    url.pathname.endsWith("/") || url.pathname.endsWith("index.html");
  const isData = url.pathname.endsWith("/data/recipes.json");
  if (isHTML || isData) {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const cl = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cl)); return r; })
        .catch(() => caches.match(e.request, { ignoreSearch: isData }).then((c) => c || caches.match("index.html")))
    );
    return;
  }

  // версионные ассеты и картинки — сначала кэш, потом сеть с дозаписью
  e.respondWith(
    caches.match(e.request).then((cached) =>
      cached ||
      fetch(e.request).then((r) => {
        if (r.ok) {
          const cl = r.clone();
          caches.open(url.pathname.includes("/images/") ? IMG_CACHE : CACHE).then((c) => c.put(e.request, cl));
        }
        return r;
      }).catch(() => cached)
    )
  );
});
