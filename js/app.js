"use strict";

// Основные теги для фильтра на главной (в этом порядке).
// Показываются только те, что есть хотя бы у одного рецепта (поле main).
const MAIN_TAGS = [
  "Первое",
  "Второе",
  "Салат",
  "Десерт",
  "Напиток",
  "Курица",
  "Свинина",
  "Говядина",
  "Шоколад",
];

const state = {
  recipes: [],
  query: "",
  activeTag: null,
};

const els = {
  grid: document.getElementById("grid"),
  count: document.getElementById("count"),
  tags: document.getElementById("tags"),
  empty: document.getElementById("empty"),
  search: document.getElementById("search"),
  listView: document.getElementById("list-view"),
  detailView: document.getElementById("detail-view"),
};

// --- Загрузка данных ---
async function load() {
  try {
    const res = await fetch("data/recipes.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    state.recipes = await res.json();
  } catch (err) {
    els.grid.innerHTML =
      '<p class="empty">Не удалось загрузить рецепты 😔<br>' + err.message + "</p>";
    return;
  }
  buildTags();
  route();
}

// --- Поиск/фильтрация ---
function matches(recipe) {
  if (state.activeTag) {
    if (!(recipe.main || []).includes(state.activeTag)) return false;
  }
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    recipe.title,
    recipe.category,
    (recipe.main || []).join(" "),
    (recipe.tags || []).join(" "),
    (recipe.ingredients || []).join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function buildTags() {
  const present = new Set();
  state.recipes.forEach((r) => (r.main || []).forEach((t) => present.add(t)));
  const tags = MAIN_TAGS.filter((t) => present.has(t));
  els.tags.innerHTML =
    `<button class="tag-chip" data-tag="">Все</button>` +
    tags
      .map((t) => `<button class="tag-chip" data-tag="${esc(t)}">${esc(t)}</button>`)
      .join("");
  els.tags.querySelectorAll(".tag-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tag = btn.dataset.tag || null;
      state.activeTag = state.activeTag === tag ? null : tag;
      renderList();
    });
  });
}

// --- Рендер списка ---
function renderList() {
  els.tags.querySelectorAll(".tag-chip").forEach((btn) => {
    const tag = btn.dataset.tag || null;
    btn.classList.toggle("active", tag === state.activeTag);
  });

  const filtered = state.recipes.filter(matches);
  els.empty.hidden = filtered.length > 0;
  els.count.textContent = filtered.length
    ? `Рецептов: ${filtered.length}`
    : "";

  els.grid.innerHTML = filtered
    .map((r) => {
      const img = r.image
        ? `<img src="${esc(r.image)}" alt="${esc(r.title)}" loading="lazy">`
        : emojiFor(r);
      const tags = (r.main || [])
        .map((t) => `<span class="mini-tag">${esc(t)}</span>`)
        .join("");
      const meta = [r.time, r.servings].filter(Boolean).map(esc).join(" · ");
      return `<a class="card" href="#/recipe/${encodeURIComponent(r.id)}">
        <div class="card-img">${img}</div>
        <div class="card-body">
          <h3 class="card-title">${esc(r.title)}</h3>
          <div class="card-tags">${tags}</div>
          ${meta ? `<div class="card-meta">${meta}</div>` : ""}
        </div>
      </a>`;
    })
    .join("");
}

// --- Рендер карточки рецепта ---
function renderDetail(id) {
  const r = state.recipes.find((x) => x.id === id);
  if (!r) {
    location.hash = "#";
    return;
  }
  const img = r.image
    ? `<img src="${esc(r.image)}" alt="${esc(r.title)}">`
    : emojiFor(r);
  const meta = [r.time, r.servings, r.category]
    .filter(Boolean)
    .map((m) => `<span>${esc(m)}</span>`)
    .join("");
  const allTags = [...new Set([...(r.main || []), ...(r.tags || [])])];
  const tags = allTags
    .map((t) => `<span class="mini-tag">${esc(t)}</span>`)
    .join("");
  const ingredients = (r.ingredients || [])
    .map((i) =>
      i && typeof i === "object" && i.h
        ? `<li class="sub-head">${esc(i.h)}</li>`
        : `<li>${esc(i)}</li>`
    )
    .join("");
  const steps = (r.steps || [])
    .map((s) =>
      s && typeof s === "object" && s.h
        ? `<li class="sub-head">${esc(s.h)}</li>`
        : `<li>${esc(s)}</li>`
    )
    .join("");

  els.detailView.innerHTML = `
    <button class="back-btn" id="back">← К списку рецептов</button>
    <div class="detail-hero">${img}</div>
    <h1 class="detail-title">${esc(r.title)}</h1>
    <div class="detail-meta">${meta}</div>
    <div class="detail-tags">${tags}</div>
    <div class="detail-cols">
      <div class="panel">
        <h2>Ингредиенты</h2>
        <ul class="ingredients-list">${ingredients}</ul>
      </div>
      <div class="panel">
        <h2>Приготовление</h2>
        <ol class="steps-list">${steps}</ol>
      </div>
    </div>`;
  document.getElementById("back").addEventListener("click", () => {
    location.hash = "#";
  });
  window.scrollTo(0, 0);
}

// --- Роутинг по хэшу ---
function route() {
  const hash = location.hash;
  const m = hash.match(/^#\/recipe\/(.+)$/);
  if (m) {
    els.listView.hidden = true;
    els.detailView.hidden = false;
    document.body.classList.add("detail-open");
    renderDetail(decodeURIComponent(m[1]));
  } else {
    els.detailView.hidden = true;
    els.listView.hidden = false;
    document.body.classList.remove("detail-open");
    renderList();
  }
}

// --- Утилиты ---
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const EMOJI = {
  Завтраки: "🍳", Завтрак: "🍳",
  Супы: "🍲", Суп: "🍲",
  Салаты: "🥗", Салат: "🥗",
  Ужины: "🍽️", Ужин: "🍽️",
  Обеды: "🍛", Обед: "🍛",
  Десерты: "🍰", Десерт: "🍰", сладкое: "🍰",
  Выпечка: "🥐",
  Напитки: "🥤",
  паста: "🍝", мясо: "🥩", рыба: "🐟", курица: "🍗", овощи: "🥦",
};
function emojiFor(r) {
  const keys = [r.category, ...(r.tags || [])];
  for (const k of keys) {
    if (EMOJI[k]) return EMOJI[k];
  }
  return "🍴";
}

// --- Слушатели ---
els.search.addEventListener("input", (e) => {
  state.query = e.target.value;
  if (location.hash.startsWith("#/recipe/")) location.hash = "#";
  else renderList();
});
window.addEventListener("hashchange", route);

load();
