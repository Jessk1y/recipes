"use strict";

// Основные теги для фильтра на главной (в этом порядке).
const MAIN_TAGS = [
  "Первое", "Второе", "Салат", "Десерт", "Напиток",
  "Курица", "Свинина", "Говядина", "Шоколад",
];

// ---------- Хранилище (localStorage) ----------
const LS = {
  get(key, def) {
    try { const v = localStorage.getItem("recipes:" + key); return v ? JSON.parse(v) : def; }
    catch (e) { return def; }
  },
  set(key, val) {
    try { localStorage.setItem("recipes:" + key, JSON.stringify(val)); } catch (e) {}
  },
};

const store = {
  favs: new Set(LS.get("favs", [])),
  notes: LS.get("notes", {}),
  recent: LS.get("recent", []),
  shopping: LS.get("shopping", []),
  checks: LS.get("checks", {}),
  saveFavs() { LS.set("favs", [...this.favs]); },
  saveNotes() { LS.set("notes", this.notes); },
  saveRecent() { LS.set("recent", this.recent); },
  saveShopping() { LS.set("shopping", this.shopping); },
  saveChecks() { LS.set("checks", this.checks); },
};

const state = {
  recipes: [],
  query: "",
  activeTag: null,
  sort: "new",
  maxTime: 0,      // 0 = любое
  favOnly: false,
  current: null,   // открытый рецепт
  factor: 1,       // множитель порций
};

const els = {
  grid: document.getElementById("grid"),
  count: document.getElementById("count"),
  tags: document.getElementById("tags"),
  toolbar: document.getElementById("toolbar"),
  recent: document.getElementById("recent"),
  empty: document.getElementById("empty"),
  search: document.getElementById("search"),
  listView: document.getElementById("list-view"),
  detailView: document.getElementById("detail-view"),
  shoppingView: document.getElementById("shopping-view"),
  shoppingBadge: document.getElementById("shopping-badge"),
};

// ---------- Загрузка данных ----------
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
  state.recipes.forEach((r, i) => (r._order = i)); // новизна = позиция в массиве
  buildToolbar();
  buildTags();
  updateShoppingBadge();
  route();
}

// ---------- Утилиты ----------
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Время в минутах из строки вроде "1 ч 10 мин", "40 мин", "1,5 ч"
function parseMinutes(t) {
  if (!t) return null;
  let total = 0, found = false;
  const h = String(t).match(/(\d+(?:[.,]\d+)?)\s*ч/);
  const m = String(t).match(/(\d+)\s*мин/);
  if (h) { total += parseFloat(h[1].replace(",", ".")) * 60; found = true; }
  if (m) { total += parseInt(m[1], 10); found = true; }
  return found ? Math.round(total) : null;
}

// Секунды для таймера из текста шага (берём первое упоминание времени)
function stepSeconds(text) {
  text = String(text);
  const hreg = /(\d+(?:[.,]\d+)?)\s*(?:ч(?![а-яёА-ЯЁ])|час)(?:\s*(\d+)\s*мин)?/;
  const mreg = /(\d+)(?:\s*[–—-]\s*(\d+))?\s*мин/;
  const hm = text.match(hreg), mm = text.match(mreg);
  const hi = hm ? hm.index : Infinity, mi = mm ? mm.index : Infinity;
  if (hi === Infinity && mi === Infinity) return 0;
  if (hi <= mi) {
    let s = parseFloat(hm[1].replace(",", ".")) * 3600;
    if (hm[2]) s += (+hm[2]) * 60;
    return Math.round(s);
  }
  return (mm[2] ? +mm[2] : +mm[1]) * 60;
}

// Масштабирование количеств в строке ингредиента
const SCALE_UNIT = "(?:кг|г|мл|л|шт|ст\\.?\\s*л\\.?|ч\\.?\\s*л\\.?|стакан\\w*|зубчик\\w*|плитк\\w*|банк\\w*|кружк\\w*|пачк\\w*|дольк\\w*|щепот\\w*|горст\\w*|ломтик\\w*|порц\\w*)";
function fmtNum(n) {
  n = Math.round(n * 100) / 100;
  let s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return s.replace(".", ",");
}
function numOf(tok) {
  if (tok.indexOf("/") >= 0) { const [a, b] = tok.split("/"); return (+a) / (+b); }
  return parseFloat(tok.replace(",", "."));
}
function scaleQty(str, f) {
  if (!f || f === 1) return str;
  const QTY = "\\d+(?:[.,]\\d+)?(?:/\\d+)?";
  const re = new RegExp("(" + QTY + ")(\\s*[–—-]\\s*(" + QTY + "))?\\s*(?=" + SCALE_UNIT + "(?![А-Яа-яЁёA-Za-z]))", "g");
  return str.replace(re, (m, a, rng, b) => {
    let out = fmtNum(numOf(a) * f);
    if (b) out += "–" + fmtNum(numOf(b) * f);
    return out + " ";
  });
}

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
    </label>`;

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
  if (state.favOnly && !store.favs.has(recipe.id)) return false;
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
  const fav = store.favs.has(r.id);
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
    ? store.recent.map((id) => state.recipes.find((r) => r.id === id)).filter(Boolean).slice(0, 8)
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
  if (store.favs.has(id)) store.favs.delete(id);
  else store.favs.add(id);
  store.saveFavs();
  if (state.current && state.current.id === id) renderDetail(id);
  else renderList();
}

// ---------- Рендер карточки рецепта ----------
function ingredientsHTML(r, factor) {
  const checks = (store.checks[r.id] && store.checks[r.id].ing) || {};
  return (r.ingredients || []).map((i, idx) => {
    if (i && typeof i === "object" && i.h) return `<li class="sub-head">${esc(i.h)}</li>`;
    const txt = scaleQty(String(i), factor);
    const on = checks[idx] ? " checked" : "";
    return `<li class="check-item${on}" data-ing="${idx}"><span class="cbox"></span><span class="ctext">${esc(txt)}</span></li>`;
  }).join("");
}

function stepsHTML(r) {
  const checks = (store.checks[r.id] && store.checks[r.id].step) || {};
  return (r.steps || []).map((s, idx) => {
    if (s && typeof s === "object" && s.h) return `<li class="sub-head">${esc(s.h)}</li>`;
    const on = checks[idx] ? " checked" : "";
    const sec = stepSeconds(s);
    const timer = sec ? `<button class="timer-btn" data-sec="${sec}">⏱ ${fmtClock(sec)}</button>` : "";
    return `<li class="step-item${on}" data-step="${idx}"><div class="step-text">${esc(s)}</div>${timer}</li>`;
  }).join("");
}

function fmtClock(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function renderDetail(id) {
  const r = state.recipes.find((x) => x.id === id);
  if (!r) { location.hash = "#"; return; }
  state.current = r;
  state.factor = 1;
  pushRecent(id);

  const img = r.image ? `<img src="${esc(r.image)}" alt="${esc(r.title)}">` : emojiFor(r);
  const meta = [r.time, r.servings].filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join("");
  const allTags = [...new Set([...(r.main || []), ...(r.tags || [])])];
  const tags = allTags.map((t) => `<span class="mini-tag">${esc(t)}</span>`).join("");
  const fav = store.favs.has(r.id);
  const note = store.notes[r.id] || "";

  els.detailView.innerHTML = `
    <div class="detail-top">
      <button class="back-btn" id="back">← К списку</button>
      <div class="detail-actions">
        <button class="act-btn" id="favBtn">${fav ? "★ В избранном" : "☆ В избранное"}</button>
        <button class="act-btn" id="shareBtn">🔗 Поделиться</button>
        <button class="act-btn" id="printBtn">🖨️ Печать</button>
      </div>
    </div>
    <div class="detail-hero">${img}</div>
    <h1 class="detail-title">${esc(r.title)}</h1>
    <div class="detail-meta">${meta}</div>
    <div class="detail-tags">${tags}</div>

    <div class="detail-controls">
      <div class="servings-ctl">Порции:
        <button class="srv" data-f="0.5">½</button>
        <button class="srv active" data-f="1">1×</button>
        <button class="srv" data-f="2">2×</button>
        <button class="srv" data-f="3">3×</button>
      </div>
      <button class="act-btn" id="toShopping">🛒 В список покупок</button>
    </div>

    <div class="detail-cols">
      <div class="panel">
        <h2>Ингредиенты <span class="hint">(нажми, чтобы вычеркнуть)</span></h2>
        <ul class="ingredients-list" id="ingList">${ingredientsHTML(r, 1)}</ul>
      </div>
      <div class="panel">
        <h2>Приготовление</h2>
        <ol class="steps-list" id="stepList">${stepsHTML(r)}</ol>
      </div>
    </div>

    <div class="panel notes-panel">
      <h2>📝 Мои заметки</h2>
      <textarea id="noteArea" class="note-area" placeholder="Например: в следующий раз меньше соли…">${esc(note)}</textarea>
    </div>`;

  // back
  document.getElementById("back").addEventListener("click", () => { location.hash = "#"; });
  // fav
  document.getElementById("favBtn").addEventListener("click", () => toggleFav(r.id));
  // share
  document.getElementById("shareBtn").addEventListener("click", () => shareRecipe(r));
  // print
  document.getElementById("printBtn").addEventListener("click", () => window.print());
  // servings
  els.detailView.querySelectorAll(".srv").forEach((b) => {
    b.addEventListener("click", () => {
      state.factor = parseFloat(b.dataset.f);
      els.detailView.querySelectorAll(".srv").forEach((x) => x.classList.toggle("active", x === b));
      document.getElementById("ingList").innerHTML = ingredientsHTML(r, state.factor);
      bindIngChecks(r);
    });
  });
  // add to shopping
  document.getElementById("toShopping").addEventListener("click", () => addToShopping(r, state.factor));
  // notes autosave
  document.getElementById("noteArea").addEventListener("input", (e) => {
    const v = e.target.value;
    if (v.trim()) store.notes[r.id] = v; else delete store.notes[r.id];
    store.saveNotes();
  });

  bindIngChecks(r);
  bindStepChecks(r);
  bindTimers();
  requestWake();
  window.scrollTo(0, 0);
}

function bindIngChecks(r) {
  document.querySelectorAll("#ingList .check-item").forEach((li) => {
    li.addEventListener("click", () => {
      const idx = li.dataset.ing;
      li.classList.toggle("checked");
      const c = (store.checks[r.id] = store.checks[r.id] || { ing: {}, step: {} });
      c.ing = c.ing || {};
      if (li.classList.contains("checked")) c.ing[idx] = 1; else delete c.ing[idx];
      store.saveChecks();
    });
  });
}
function bindStepChecks(r) {
  document.querySelectorAll("#stepList .step-item").forEach((li) => {
    li.querySelector(".step-text").addEventListener("click", () => {
      const idx = li.dataset.step;
      li.classList.toggle("checked");
      const c = (store.checks[r.id] = store.checks[r.id] || { ing: {}, step: {} });
      c.step = c.step || {};
      if (li.classList.contains("checked")) c.step[idx] = 1; else delete c.step[idx];
      store.saveChecks();
    });
  });
}

// ---------- Таймеры ----------
const timers = new Map();
function bindTimers() {
  document.querySelectorAll(".timer-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (timers.has(btn)) { stopTimer(btn); return; }
      let left = +btn.dataset.sec;
      btn.classList.add("running");
      btn.textContent = "⏸ " + fmtClock(left);
      const iv = setInterval(() => {
        left--;
        if (left <= 0) { finishTimer(btn); return; }
        btn.textContent = "⏸ " + fmtClock(left);
      }, 1000);
      timers.set(btn, iv);
    });
  });
}
function stopTimer(btn) {
  clearInterval(timers.get(btn));
  timers.delete(btn);
  btn.classList.remove("running");
  btn.textContent = "⏱ " + fmtClock(+btn.dataset.sec);
}
function finishTimer(btn) {
  clearInterval(timers.get(btn));
  timers.delete(btn);
  btn.classList.remove("running");
  btn.classList.add("done");
  btn.textContent = "✅ Готово!";
  beep();
}
function beep() {
  try {
    const A = new (window.AudioContext || window.webkitAudioContext)();
    const o = A.createOscillator(), g = A.createGain();
    o.connect(g); g.connect(A.destination);
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.001, A.currentTime);
    g.gain.exponentialRampToValueAtTime(0.3, A.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, A.currentTime + 0.6);
    o.start(); o.stop(A.currentTime + 0.6);
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate([250, 120, 250]);
}

// ---------- Wake Lock ----------
let wakeLock = null;
async function requestWake() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); }
  catch (e) {}
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && document.body.classList.contains("detail-open")) requestWake();
});

// ---------- Поделиться ----------
async function shareRecipe(r) {
  const url = location.origin + location.pathname + "#/recipe/" + encodeURIComponent(r.id);
  const data = { title: r.title, text: "Рецепт: " + r.title, url };
  if (navigator.share) { try { await navigator.share(data); return; } catch (e) {} }
  try { await navigator.clipboard.writeText(url); toast("Ссылка скопирована 📋"); }
  catch (e) { prompt("Скопируй ссылку:", url); }
}

// ---------- Недавние ----------
function pushRecent(id) {
  store.recent = [id, ...store.recent.filter((x) => x !== id)].slice(0, 8);
  store.saveRecent();
}

// ---------- Список покупок ----------
function addToShopping(r, factor) {
  const items = (r.ingredients || [])
    .filter((i) => !(i && typeof i === "object"))
    .map((i) => scaleQty(String(i), factor));
  let added = 0;
  items.forEach((it) => { if (!store.shopping.includes(it)) { store.shopping.push(it); added++; } });
  store.saveShopping();
  updateShoppingBadge();
  toast(added ? `Добавлено в список: ${added} 🛒` : "Уже в списке");
}
function updateShoppingBadge() {
  const n = store.shopping.length;
  els.shoppingBadge.hidden = n === 0;
  els.shoppingBadge.textContent = n;
}
function renderShopping() {
  const items = store.shopping;
  els.shoppingView.innerHTML = `
    <div class="detail-top">
      <button class="back-btn" id="shBack">← К списку</button>
      ${items.length ? `<button class="act-btn" id="shClear">🗑 Очистить</button>` : ""}
    </div>
    <h1 class="detail-title">🛒 Список покупок</h1>
    ${items.length
      ? `<ul class="ingredients-list shopping-list">${items.map((it, i) =>
          `<li class="check-item" data-sh="${i}"><span class="cbox"></span><span class="ctext">${esc(it)}</span><button class="sh-del" data-del="${i}" title="Удалить">✕</button></li>`).join("")}</ul>`
      : `<p class="empty">Список пуст. Открой рецепт и нажми «🛒 В список покупок».</p>`}`;
  document.getElementById("shBack").addEventListener("click", () => { location.hash = "#"; });
  const clr = document.getElementById("shClear");
  if (clr) clr.addEventListener("click", () => {
    if (confirm("Очистить весь список покупок?")) { store.shopping = []; store.saveShopping(); updateShoppingBadge(); renderShopping(); }
  });
  els.shoppingView.querySelectorAll(".check-item").forEach((li) => {
    li.querySelector(".ctext").addEventListener("click", () => li.classList.toggle("checked"));
    li.querySelector(".cbox").addEventListener("click", () => li.classList.toggle("checked"));
  });
  els.shoppingView.querySelectorAll(".sh-del").forEach((b) => {
    b.addEventListener("click", () => {
      store.shopping.splice(+b.dataset.del, 1);
      store.saveShopping(); updateShoppingBadge(); renderShopping();
    });
  });
}

// ---------- Тосты ----------
let toastTimer = null;
function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------- Тема ----------
function initTheme() {
  let theme = LS.get("theme", null);
  if (!theme) theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(theme);
  const btn = document.getElementById("theme-btn");
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next); LS.set("theme", next);
  });
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById("theme-btn");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#1c1a17" : "#e8662a";
}

// ---------- Роутинг ----------
function route() {
  const hash = location.hash;
  const m = hash.match(/^#\/recipe\/(.+)$/);
  els.listView.hidden = true; els.detailView.hidden = true; els.shoppingView.hidden = true;
  document.body.classList.remove("detail-open");
  if (m) {
    els.detailView.hidden = false;
    document.body.classList.add("detail-open");
    renderDetail(decodeURIComponent(m[1]));
  } else if (hash === "#/shopping") {
    els.shoppingView.hidden = false;
    document.body.classList.add("detail-open");
    renderShopping();
    releaseWake();
  } else {
    els.listView.hidden = false;
    releaseWake();
    renderList();
  }
}

// ---------- Эмодзи-заглушка ----------
const EMOJI = {
  Завтраки: "🍳", Супы: "🍲", Салаты: "🥗", Ужины: "🍽️", Десерты: "🍰",
  Выпечка: "🥐", Напитки: "🥤",
  Первое: "🍲", Второе: "🍽️", Десерт: "🍰", Напиток: "🥤",
  Курица: "🍗", Свинина: "🥩", Говядина: "🥩", Шоколад: "🍫",
};
function emojiFor(r) {
  for (const k of [...(r.main || []), r.category]) if (EMOJI[k]) return EMOJI[k];
  return "🍴";
}

// ---------- Слушатели ----------
els.search.addEventListener("input", (e) => {
  state.query = e.target.value;
  if (location.hash.startsWith("#/recipe/") || location.hash === "#/shopping") location.hash = "#";
  else renderList();
});
document.getElementById("shopping-btn").addEventListener("click", () => { location.hash = "#/shopping"; });
window.addEventListener("hashchange", route);

// ---------- PWA ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

initTheme();
load();
