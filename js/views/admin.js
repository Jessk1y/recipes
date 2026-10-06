// Админ-панель рецептов: #/admin (список, включая черновики), #/admin/new, #/admin/edit/<slug>,
// #/admin/submissions (предложения пользователей) и #/admin/review/<slug> (поправить и опубликовать).
// Работает только онлайн (без outbox); права проверяет сервер — здесь только скрываем лишнее.
import { WAKE_HINT_AFTER } from "../config.js";
import { els } from "./ui.js";
import { isAdmin } from "../core/store.js";
import * as endpoints from "../api/endpoints.js";
import { ApiError, NetworkError, imageUrl } from "../api/client.js";
import { refreshCatalog } from "../sync/catalog.js";
import { esc, toast, emojiFor } from "../lib/utils.js";
import { mountRecipeForm } from "./recipeForm.js";

let renderSeq = 0; // защита от устаревших ответов при быстрой смене экранов

export function renderAdmin(path) {
  const seq = ++renderSeq;
  if (!isAdmin()) {
    els.adminView.innerHTML = `
      <div class="detail-top"><button class="back-btn" id="adBack">← К списку</button></div>
      <p class="empty">Раздел только для администратора. <a href="#/account">Войти</a></p>`;
    document.getElementById("adBack").addEventListener("click", () => { location.hash = "#"; });
    return;
  }
  const m = path.match(/^\/edit\/(.+)$/);
  const rv = path.match(/^\/review\/(.+)$/);
  if (path === "/new") renderForm(null, seq);
  else if (m) renderForm(decodeURIComponent(m[1]), seq);
  else if (rv) renderReview(decodeURIComponent(rv[1]), seq);
  else if (path === "/submissions") renderQueue(seq);
  else renderList(seq);
}

function loading(text) {
  els.adminView.innerHTML = `<p class="empty" id="adLoading">${esc(text)}</p>`;
  return setTimeout(() => {
    const el = document.getElementById("adLoading");
    if (el) el.textContent = text + " Сервер просыпается — это может занять до минуты.";
  }, WAKE_HINT_AFTER);
}

function showError(err, retry) {
  const msg = err instanceof NetworkError
    ? "Нет связи с сервером. Админка работает только онлайн."
    : err.message;
  els.adminView.innerHTML = `
    <div class="detail-top"><button class="back-btn" id="adBack">← К списку</button></div>
    <p class="empty">⚠️ ${esc(msg)}<br><br><button class="tool-btn" id="adRetry">Повторить</button></p>`;
  document.getElementById("adBack").addEventListener("click", () => { location.hash = "#"; });
  document.getElementById("adRetry").addEventListener("click", retry);
}

// ---------- Вкладки «Рецепты | Предложенные» ----------
let queueCount = null; // число предложений на модерации (обновляется при открытии очереди)
function tabs(active, count) {
  if (count !== undefined) queueCount = count;
  const n = queueCount ? ` (${queueCount})` : "";
  return `<div class="auth-tabs admin-tabs">
    <button class="tag-chip${active === "recipes" ? " active" : ""}" data-tab="recipes">Рецепты</button>
    <button class="tag-chip${active === "submissions" ? " active" : ""}" data-tab="submissions">Предложенные<span class="tab-count">${n}</span></button>
  </div>`;
}
function bindTabs() {
  document.querySelectorAll(".admin-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => {
    location.hash = b.dataset.tab === "recipes" ? "#/admin" : "#/admin/submissions";
  }));
}

// ---------- Список ----------
let filter = "";
async function renderList(seq) {
  const hint = loading("Загрузка рецептов…");
  let recipes;
  try {
    recipes = await endpoints.adminRecipes();
  } catch (e) {
    if (seq === renderSeq) showError(e, () => renderAdmin(""));
    return;
  } finally {
    clearTimeout(hint);
  }
  if (seq !== renderSeq) return;

  els.adminView.innerHTML = `
    <div class="detail-top">
      <button class="back-btn" id="adBack">← К сайту</button>
      <button class="tool-btn accent" id="adNew">＋ Новый рецепт</button>
    </div>
    <h1 class="detail-title">🛠 Рецепты</h1>
    ${tabs("recipes")}
    <div class="search-box admin-search"><input id="adFilter" type="search" placeholder="Найти рецепт…" value="${esc(filter)}"></div>
    <div class="count" id="adCount"></div>
    <ul class="admin-list" id="adList"></ul>`;
  bindTabs();
  // число предложений на вкладке — в фоне, без блокировки списка
  endpoints.adminQueue().then((q) => {
    if (seq !== renderSeq) return;
    queueCount = q.length;
    const cnt = document.querySelector('[data-tab="submissions"] .tab-count');
    if (cnt) cnt.textContent = q.length ? ` (${q.length})` : "";
  }).catch(() => {});

  const listEl = document.getElementById("adList");
  const draw = () => {
    const q = filter.trim().toLowerCase();
    const shown = recipes.filter((r) => !q || r.title.toLowerCase().includes(q) || r.slug.includes(q));
    const drafts = recipes.filter((r) => r.status === "DRAFT").length;
    document.getElementById("adCount").textContent =
      `Всего: ${recipes.length}` + (drafts ? ` · черновиков: ${drafts}` : "");
    listEl.innerHTML = shown.map((r) => {
      const img = r.image ? `<img src="${esc(imageUrl(r.image))}" alt="" loading="lazy">` : emojiFor({ main: r.main, category: r.category.name });
      const pub = r.status === "PUBLISHED";
      return `<li class="admin-row" data-id="${esc(r.id)}">
        <div class="recent-img admin-thumb">${img}</div>
        <div class="admin-info">
          <div class="admin-title">${esc(r.title)}</div>
          <div class="admin-sub"><span class="status-badge ${pub ? "pub" : "draft"}">${pub ? "Опубликован" : "Черновик"}</span>
            ${esc(r.category.name)} · <code>${esc(r.slug)}</code></div>
        </div>
        <div class="admin-btns">
          <button class="act-btn" data-act="edit" data-slug="${esc(r.slug)}">✏️ Изменить</button>
          <button class="act-btn" data-act="status">${pub ? "🙈 В черновик" : "👁 Опубликовать"}</button>
          <button class="act-btn danger" data-act="del">🗑</button>
        </div>
      </li>`;
    }).join("") || `<p class="empty">Ничего не нашлось</p>`;
  };
  draw();

  document.getElementById("adBack").addEventListener("click", () => { location.hash = "#"; });
  document.getElementById("adNew").addEventListener("click", () => { location.hash = "#/admin/new"; });
  document.getElementById("adFilter").addEventListener("input", (e) => { filter = e.target.value; draw(); });
  listEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const row = btn.closest(".admin-row");
    const r = recipes.find((x) => x.id === row.dataset.id);
    if (btn.dataset.act === "edit") { location.hash = "#/admin/edit/" + encodeURIComponent(r.slug); return; }
    btn.disabled = true;
    try {
      if (btn.dataset.act === "status") {
        const next = r.status === "PUBLISHED" ? "DRAFT" : "PUBLISHED";
        await endpoints.setRecipeStatus(r.id, next);
        r.status = next;
        toast(next === "PUBLISHED" ? "Опубликовано 👁" : "Снято с публикации");
      } else if (btn.dataset.act === "del") {
        if (!confirm(`Удалить «${r.title}»? Это нельзя отменить.`)) { btn.disabled = false; return; }
        await endpoints.deleteRecipe(r.id);
        recipes = recipes.filter((x) => x !== r);
        toast("Рецепт удалён 🗑");
      }
      draw();
      refreshCatalog().catch(() => {});
    } catch (err) {
      btn.disabled = false;
      toast("⚠️ " + (err instanceof NetworkError ? "Нет связи с сервером" : err.message));
    }
  });
}

// ---------- Форма ----------
async function renderForm(slug, seq) {
  const hint = loading(slug ? "Загрузка рецепта…" : "Подготовка формы…");
  let recipe = null, cats = [];
  try {
    [recipe, cats] = await Promise.all([
      slug ? endpoints.adminRecipe(slug) : null,
      endpoints.categories().catch(() => []),
    ]);
  } catch (e) {
    if (seq === renderSeq) showError(e, () => renderAdmin(slug ? "/edit/" + encodeURIComponent(slug) : "/new"));
    return;
  } finally {
    clearTimeout(hint);
  }
  if (seq !== renderSeq) return;
  mountRecipeForm(els.adminView, {
    mode: "admin", recipe, cats,
    title: recipe ? "✏️ " + recipe.title : "＋ Новый рецепт",
    backLabel: "← К рецептам", onBack: () => { location.hash = "#/admin"; },
    topExtra: recipe && recipe.status === "PUBLISHED" ? `<a class="act-btn" href="#/recipe/${encodeURIComponent(recipe.slug)}">Открыть на сайте</a>` : "",
    save: (input) => (recipe ? endpoints.updateRecipe(recipe.id, input) : endpoints.createRecipe(input)),
    onSaved: (saved) => {
      toast(saved.status === "PUBLISHED" ? "Сохранено и опубликовано ✅" : "Сохранено как черновик ✅");
      refreshCatalog().catch(() => {});
      location.hash = "#/admin";
    },
  });
}

// ---------- Предложенные (модерация) ----------
async function renderQueue(seq) {
  const hint = loading("Загрузка предложений…");
  let items;
  try {
    items = await endpoints.adminQueue();
  } catch (e) {
    if (seq === renderSeq) showError(e, () => renderAdmin("/submissions"));
    return;
  } finally {
    clearTimeout(hint);
  }
  if (seq !== renderSeq) return;
  els.adminView.innerHTML = `
    <div class="detail-top"><button class="back-btn" id="adBack">← К сайту</button></div>
    <h1 class="detail-title">🛠 Рецепты</h1>
    ${tabs("submissions", items.length)}
    <ul class="admin-list" id="adList"></ul>`;
  bindTabs();
  document.getElementById("adBack").addEventListener("click", () => { location.hash = "#"; });
  const listEl = document.getElementById("adList");
  const draw = () => {
    listEl.innerHTML = items.map((r) => {
      const img = r.image ? `<img src="${esc(imageUrl(r.image))}" alt="" loading="lazy">` : emojiFor({ main: r.main, category: r.category.name });
      const when = new Date(r.submittedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      return `<li class="admin-row" data-id="${esc(r.id)}">
        <div class="recent-img admin-thumb">${img}</div>
        <div class="admin-info">
          <div class="admin-title">${esc(r.title)}</div>
          <div class="admin-sub"><span class="status-badge pending">На модерации</span>
            ${esc(r.category.name)} · ${esc(r.author ? `${r.author.displayName} (${r.author.email})` : "автор удалён")} · ${esc(when)}</div>
        </div>
        <div class="admin-btns">
          <button class="act-btn" data-act="review">✏️ Поправить и опубликовать</button>
          <button class="act-btn" data-act="approve">✅ Одобрить</button>
          <button class="act-btn danger" data-act="reject">❌ Отклонить</button>
        </div>
      </li>`;
    }).join("") || `<p class="empty">Новых предложений нет 🎉</p>`;
    const cnt = document.querySelector('[data-tab="submissions"] .tab-count');
    if (cnt) cnt.textContent = items.length ? ` (${items.length})` : "";
    queueCount = items.length;
  };
  draw();
  listEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const r = items.find((x) => x.id === btn.closest(".admin-row").dataset.id);
    if (btn.dataset.act === "review") { location.hash = "#/admin/review/" + encodeURIComponent(r.slug); return; }
    const rejecting = btn.dataset.act === "reject";
    let reason = null;
    if (rejecting) {
      reason = prompt(`Причина отказа для «${r.title}» (её увидит автор):`);
      if (reason === null) return;
      if (reason.trim().length < 3) { toast("⚠️ Укажите причину (от 3 символов)"); return; }
    }
    btn.disabled = true;
    try {
      if (rejecting) await endpoints.rejectSubmission(r.id, reason.trim()); else await endpoints.approveSubmission(r.id);
      items = items.filter((x) => x !== r);
      toast(rejecting ? "Отклонено" : "Опубликовано ✅");
      draw();
      if (!rejecting) refreshCatalog().catch(() => {});
    } catch (err) {
      btn.disabled = false;
      toast("⚠️ " + (err instanceof NetworkError ? "Нет связи с сервером" : err.message));
      if (err instanceof ApiError && err.status === 409) renderAdmin("/submissions"); // уже рассмотрено — обновить очередь
    }
  });
}

async function renderReview(slug, seq) {
  const hint = loading("Загрузка предложения…");
  let item, cats = [];
  try {
    const [queue, c] = await Promise.all([endpoints.adminQueue(), endpoints.categories().catch(() => [])]);
    item = queue.find((x) => x.slug === slug);
    cats = c;
  } catch (e) {
    if (seq === renderSeq) showError(e, () => renderAdmin("/review/" + encodeURIComponent(slug)));
    return;
  } finally {
    clearTimeout(hint);
  }
  if (seq !== renderSeq) return;
  if (!item) { toast("Предложение уже рассмотрено"); location.hash = "#/admin/submissions"; return; }
  mountRecipeForm(els.adminView, {
    mode: "moderate", recipe: item, cats,
    title: "✏️ " + item.title,
    notice: `<div class="form-msg info">Предложил(а): ${esc(item.author ? `${item.author.displayName} · ${item.author.email}` : "автор удалён")}.
      Сохранение опубликует рецепт.</div>`,
    backLabel: "← К предложениям", onBack: () => { location.hash = "#/admin/submissions"; },
    saveLabel: "✅ Сохранить и опубликовать",
    save: (input) => endpoints.updateRecipe(item.id, input),
    onSaved: () => {
      toast("Опубликовано ✅");
      refreshCatalog().catch(() => {});
      location.hash = "#/admin/submissions";
    },
  });
}
