// Главная: тулбар, фильтры по основным тегам, сетка карточек, «Недавно смотрели».
import { MAIN_TAGS } from "../config.js";
import { state, els } from "./ui.js";
import { isFav, getRecent, isAdmin } from "../core/store.js";
import * as actions from "../core/actions.js";
import { esc, parseMinutes, emojiFor } from "../lib/utils.js";
import { renderDetail } from "./detail.js";

// ---------- Тулбар (главная) ----------
function buildToolbar() {
  els.toolbar.innerHTML = `
    <button id="randomBtn" class="tool-btn accent" title="Случайный рецепт">🎲 Что приготовить?</button>
    <button id="favFilter" class="tool-btn" title="Только избранное">⭐ Избранное</button>
    <label class="tool-select">Сортировка:
      <select id="sortSel">
        <option value="new">по новизне</option>
        <option value="time">сначала быстрые</option>
        <option value="alpha">по алфавиту</option>
      </select>
    </label>
    <label class="tool-select">Время:
      <select id="timeSel">
        <option value="0">любое</option>
        <option value="20">до 20 мин</option>
        <option value="40">до 40 мин</option>
        <option value="60">до 60 мин</option>
      </select>
    </label>
    <button id="adminBtn" class="tool-btn" title="Управление рецептами" hidden>🛠 Админка</button>`;

  document.getElementById("adminBtn").addEventListener("click", () => { location.hash = "#/admin"; });
  updateAdminBtn();
  document.getElementById("randomBtn").addEventListener("click", () => {
    const pool = state.recipes.filter(matches);
    const src = pool.length ? pool : state.recipes;
    const r = src[Math.floor(Math.random() * src.length)];
    if (r) location.hash = "#/recipe/" + encodeURIComponent(r.id);
  });
  const favBtn = document.getElementById("favFilter");
  favBtn.addEventListener("click", () => {
    state.favOnly = !state.favOnly;
    favBtn.classList.toggle("active", state.favOnly);
    renderList();
  });
  document.getElementById("sortSel").addEventListener("change", (e) => {
    state.sort = e.target.value; renderList();
  });
  document.getElementById("timeSel").addEventListener("change", (e) => {
    state.maxTime = +e.target.value; renderList();
  });
}

// ---------- Фильтрация ----------
function matches(recipe) {
  if (state.favOnly && !isFav(recipe.id)) return false;
  if (state.activeTag && !(recipe.main || []).includes(state.activeTag)) return false;
  if (state.maxTime) {
    const mins = parseMinutes(recipe.time);
    if (mins === null || mins > state.maxTime) return false;
  }
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    recipe.title, recipe.category,
    (recipe.main || []).join(" "),
    (recipe.tags || []).join(" "),
    (recipe.ingredients || []).filter((x) => typeof x === "string").join(" "),
  ].join(" ").toLowerCase();
  return haystack.includes(q);
}

function buildTags() {
  const present = new Set();
  state.recipes.forEach((r) => (r.main || []).forEach((t) => present.add(t)));
  const tags = MAIN_TAGS.filter((t) => present.has(t));
  els.tags.innerHTML =
    `<button class="tag-chip" data-tag="">Все</button>` +
    tags.map((t) => `<button class="tag-chip" data-tag="${esc(t)}">${esc(t)}</button>`).join("");
  els.tags.querySelectorAll(".tag-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tag = btn.dataset.tag || null;
      state.activeTag = state.activeTag === tag ? null : tag;
      renderList();
    });
  });
}

// ---------- Рендер списка ----------
function sortRecipes(arr) {
  const a = arr.slice();
  if (state.sort === "alpha") a.sort((x, y) => x.title.localeCompare(y.title, "ru"));
  else if (state.sort === "time") a.sort((x, y) => {
    const mx = parseMinutes(x.time), my = parseMinutes(y.time);
    return (mx === null ? 1e9 : mx) - (my === null ? 1e9 : my);
  });
  else a.sort((x, y) => x._order - y._order);
  return a;
}

function cardHTML(r) {
  const img = r.image
    ? `<img src="${esc(r.image)}" alt="${esc(r.title)}" loading="lazy">`
    : emojiFor(r);
  const tags = (r.main || []).map((t) => `<span class="mini-tag">${esc(t)}</span>`).join("");
  const meta = [r.time, r.servings].filter(Boolean).map(esc).join(" · ");
  const fav = isFav(r.id);
  return `<a class="card" href="#/recipe/${encodeURIComponent(r.id)}">
    <div class="card-img">${img}
      <button class="fav-star${fav ? " on" : ""}" data-fav="${esc(r.id)}" title="В избранное" aria-label="В избранное">${fav ? "★" : "☆"}</button>
    </div>
    <div class="card-body">
      <h3 class="card-title">${esc(r.title)}</h3>
      <div class="card-tags">${tags}</div>
      ${meta ? `<div class="card-meta">${meta}</div>` : ""}
    </div>
  </a>`;
}

function renderList() {
  els.tags.querySelectorAll(".tag-chip").forEach((btn) => {
    const tag = btn.dataset.tag || null;
    btn.classList.toggle("active", tag === state.activeTag);
  });

  // Недавно просмотренные (только без активных фильтров)
  const noFilters = !state.query && !state.activeTag && !state.favOnly && !state.maxTime;
  const recentItems = noFilters
    ? getRecent().map((id) => state.recipes.find((r) => r.id === id)).filter(Boolean).slice(0, 8)
    : [];
  if (recentItems.length > 1) {
    els.recent.hidden = false;
    els.recent.innerHTML =
      `<div class="recent-title">🕒 Недавно смотрели</div><div class="recent-row">` +
      recentItems.map((r) => `<a class="recent-card" href="#/recipe/${encodeURIComponent(r.id)}">
        <div class="recent-img">${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy">` : emojiFor(r)}</div>
        <span>${esc(r.title)}</span></a>`).join("") + `</div>`;
  } else {
    els.recent.hidden = true;
  }

  const filtered = sortRecipes(state.recipes.filter(matches));
  els.empty.hidden = filtered.length > 0;
  els.empty.textContent = state.favOnly && !filtered.length
    ? "В избранном пока пусто ⭐ Отметь рецепты звёздочкой."
    : "Ничего не нашлось 🤷 Попробуй другой запрос.";
  els.count.textContent = filtered.length ? `Рецептов: ${filtered.length}` : "";
  els.grid.innerHTML = filtered.map(cardHTML).join("");
  bindFavStars(els.grid);
}

function bindFavStars(root) {
  root.querySelectorAll(".fav-star").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFav(btn.dataset.fav);
    });
  });
}

function toggleFav(id) {
  actions.toggleFav(id);
  if (state.current && state.current.id === id) renderDetail(id);
  else renderList();
}

// Кнопка админки видна только администратору
function updateAdminBtn() {
  const b = document.getElementById("adminBtn");
  if (b) b.hidden = !isAdmin();
}

export { buildToolbar, buildTags, renderList, bindFavStars, toggleFav, updateAdminBtn };
