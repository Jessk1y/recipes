"use strict";

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
    const inTags = (recipe.tags || []).includes(state.activeTag);
    const inCat = recipe.category === state.activeTag;
    if (!inTags && !inCat) return false;
  }
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    recipe.title,
    recipe.category,
    (recipe.tags || []).join(" "),
    (recipe.ingredients || []).join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function buildTags() {
  const set = new Set();
  state.recipes.forEach((r) => {
    if (r.category) set.add(r.category);
    (r.tags || []).forEach((t) => set.add(t));
  });
  const tags = Array.from(set).sort((a, b) => a.localeCompare(b, "ru"));
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
      const tags = (r.tags || [])
        .slice(0, 3)
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
  const tags = (r.tags || [])
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
    renderDetail(decodeURIComponent(m[1]));
  } else {
    els.detailView.hidden = true;
    els.listView.hidden = false;
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
