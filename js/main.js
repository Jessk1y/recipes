// Точка входа. Архитектура (ПР №3): Flux на ES-модулях без сборки.
//   core/      — store (состояние + dispatch), редьюсер личных данных, создатели действий
//   api/       — HTTP-клиент (токены, таймауты) и эндпоинты
//   sync/      — каталог (кэш → сеть) и синхронизация личных данных через outbox
//   views/     — экраны: список, рецепт, корзина, аккаунт, админка; таймеры/звук/Wake Lock
import { state, els } from "./views/ui.js";
import { subscribe, getUser } from "./core/store.js";
import { loadLocalCatalog, refreshCatalog, catalogLoading } from "./sync/catalog.js";
import { startSync, refreshProfile } from "./sync/sync.js";
import { setAccessToken } from "./api/client.js";
import { buildToolbar, buildTags, renderList, updateAdminBtn } from "./views/list.js";
import { renderDetail, refreshDetailData } from "./views/detail.js";
import { renderShopping, updateShoppingBadge } from "./views/shopping.js";
import { renderAccount, renderVerify, renderReset, updateAccountBtn, updateSyncLine } from "./views/account.js";
import { renderAdmin } from "./views/admin.js";
import { clearAllTimers } from "./views/timers.js";
import { releaseWake } from "./views/wake.js";
import { initTheme } from "./views/theme.js";

// ---------- Роутинг ----------
let view = null; // list | detail | shopping | account | admin
let waitingRecipe = false;

function route() {
  const hash = location.hash;
  const m = hash.match(/^#\/recipe\/(.+)$/);
  clearAllTimers(); // при смене страницы глушим таймеры/звонок
  els.listView.hidden = true; els.detailView.hidden = true; els.shoppingView.hidden = true;
  els.accountView.hidden = true; els.adminView.hidden = true;
  document.body.classList.remove("detail-open");
  waitingRecipe = false;
  if (m) {
    view = "detail";
    els.detailView.hidden = false;
    document.body.classList.add("detail-open");
    const id = decodeURIComponent(m[1]);
    // рецепта нет в сохранённой копии, но свежий каталог ещё грузится (например, ссылка на новый рецепт)
    if (!state.recipes.find((x) => x.id === id) && catalogLoading()) {
      waitingRecipe = true;
      els.detailView.innerHTML = `<p class="empty">Загрузка рецепта…</p>`;
      return;
    }
    renderDetail(id);
  } else if (hash === "#/shopping") {
    view = "shopping";
    els.shoppingView.hidden = false;
    document.body.classList.add("detail-open");
    renderShopping();
    releaseWake();
  } else if (hash === "#/account") {
    view = "account";
    els.accountView.hidden = false;
    document.body.classList.add("detail-open");
    renderAccount();
    releaseWake();
    window.scrollTo(0, 0);
  } else if (/^#\/(verify|reset)(\?|$)/.test(hash)) {
    // ссылки из писем: подтверждение e-mail и сброс пароля (экран аккаунта)
    view = "account";
    els.accountView.hidden = false;
    document.body.classList.add("detail-open");
    if (hash.startsWith("#/verify")) renderVerify(hash); else renderReset(hash);
    releaseWake();
    window.scrollTo(0, 0);
  } else if (hash.startsWith("#/admin")) {
    view = "admin";
    els.adminView.hidden = false;
    document.body.classList.add("detail-open");
    renderAdmin(hash.slice("#/admin".length));
    releaseWake();
    window.scrollTo(0, 0);
  } else {
    view = "list";
    els.listView.hidden = false;
    releaseWake();
    renderList();
  }
}

// ---------- Реакция представлений на изменения в store ----------
subscribe((action) => {
  switch (action.type) {
    case "catalog.set":
      buildTags();
      if (view === "list") renderList();
      else if (view === "shopping") renderShopping();
      else if (view === "detail" && waitingRecipe) route();
      break;
    case "data.replace":
    case "data.external":
    case "data.clear":
      updateShoppingBadge();
      if (view === "list") renderList();
      else if (view === "shopping") renderShopping();
      else if (view === "detail") refreshDetailData(); // без перерисовки — не сбивать таймеры
      break;
    case "session.set":
      if (!action.user) setAccessToken(null);
      updateAccountBtn();
      updateAdminBtn();
      // страницы по ссылкам из писем не перерисовываем: токен одноразовый
      if ((view === "account" || view === "admin") && !/^#\/(verify|reset)/.test(location.hash)) route();
      break;
    case "sync.status":
      updateAccountBtn();
      if (view === "account") updateSyncLine();
      break;
  }
});

// ---------- Слушатели ----------
els.search.addEventListener("input", (e) => {
  state.query = e.target.value;
  if (view !== "list") location.hash = "#";
  else renderList();
});
document.getElementById("shopping-btn").addEventListener("click", () => { location.hash = "#/shopping"; });
els.accountBtn.addEventListener("click", () => { location.hash = "#/account"; });
window.addEventListener("hashchange", route);

// ---------- PWA ----------
if ("serviceWorker" in navigator) {
  // когда новый service worker берёт управление — один раз перезагружаемся,
  // чтобы сразу показать свежую версию (авто-обновление).
  let swRefreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swRefreshing) return;
    swRefreshing = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.update();
      setInterval(() => reg.update(), 60 * 60 * 1000); // проверять обновления раз в час
    }).catch(() => {});
  });
}

// ---------- Запуск ----------
async function boot() {
  initTheme();
  buildToolbar();
  updateAccountBtn();
  updateShoppingBadge();
  const hasLocal = await loadLocalCatalog(); // мгновенно: копия или запасной файл
  route();
  refreshCatalog().then(() => {              // свежий каталог — в фоне
    if (waitingRecipe) route();              // каталог не изменился — рецепта нет, route() вернёт на главную
  }, () => {
    if (!hasLocal) {
      els.grid.innerHTML = '<p class="empty">Не удалось загрузить рецепты 😔<br>Проверьте подключение к интернету.</p>';
    }
    if (waitingRecipe) { waitingRecipe = false; location.hash = "#"; }
  });
  startSync();
  if (getUser()) refreshProfile();
}

boot();
