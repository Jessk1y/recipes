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
  // миграция списка покупок в формат с привязкой к блюдам {name, contribs:[{r,a}]}
  store.shopping = store.shopping.map((it) => {
    if (it && it.contribs) return it;
    const p = typeof it === "string" ? parseIng(it) : { name: it.name, amount: it.amount };
    return { name: p.name, contribs: p.amount ? [{ r: null, a: p.amount }] : [] };
  });
  store.saveShopping();
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
  let no = 0;
  return (r.steps || []).map((s, idx) => {
    if (s && typeof s === "object" && s.h) return `<li class="sub-head">${esc(s.h)}</li>`;
    no++;
    const on = checks[idx] ? " checked" : "";
    const sec = stepSeconds(s);
    const timer = sec ? `<button class="timer-btn" data-sec="${sec}">⏱ ${fmtClock(sec)}</button>` : "";
    return `<li class="step-item${on}" data-step="${idx}" data-stepno="${no}"><div class="step-text">${esc(s)}</div>${timer}</li>`;
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
      <button class="act-btn" id="resetBtn">↺ Сбросить отметки</button>
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

    <div class="panel timer-panel">
      <h2>⏱ Свой таймер</h2>
      <div class="ctimer-presets">
        <button class="ct-preset" data-min="1">1 мин</button>
        <button class="ct-preset" data-min="5">5 мин</button>
        <button class="ct-preset" data-min="10">10 мин</button>
        <button class="ct-preset" data-min="15">15 мин</button>
        <button class="ct-preset" data-min="30">30 мин</button>
      </div>
      <div class="ctimer-form">
        <input id="ctName" class="ct-input" placeholder="Название (необязательно)" />
        <input id="ctMin" class="ct-input ct-num" type="number" min="0" inputmode="numeric" placeholder="мин" />
        <input id="ctSec" class="ct-input ct-num" type="number" min="0" max="59" inputmode="numeric" placeholder="сек" />
        <button id="ctStart" class="tool-btn accent">Запустить</button>
      </div>
      <div id="ctList" class="ctimer-list"></div>
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
  // reset checks
  document.getElementById("resetBtn").addEventListener("click", () => {
    delete store.checks[r.id];
    store.saveChecks();
    renderDetail(r.id);
    toast("Отметки сброшены ↺");
  });
  // свой таймер
  document.getElementById("ctStart").addEventListener("click", addCustomTimer);
  els.detailView.querySelectorAll(".ct-preset").forEach((b) =>
    b.addEventListener("click", () => startCustomTimer((+b.dataset.min) * 60, "")));
  ["ctName", "ctMin", "ctSec"].forEach((id) =>
    document.getElementById(id).addEventListener("keydown", (e) => { if (e.key === "Enter") addCustomTimer(); }));
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
const ringingBtns = new Set();
function handleTimerClick(btn) {
  if (btn.classList.contains("ringing")) { stopRing(btn); return; }
  if (timers.has(btn)) stopTimer(btn); else startTimerBtn(btn);
}
function stopRing(btn) {
  ringingBtns.delete(btn);
  btn.classList.remove("ringing");
  btn.textContent = "✅ Готово!";
  if (ringingBtns.size === 0) silenceAlarm();
}
function clearAllTimers() {
  timers.forEach((iv) => clearInterval(iv));
  timers.clear();
  ringingBtns.clear();
  silenceAlarm();
}
function startTimerBtn(btn) {
  ensureAudio();              // разблокировать звук по жесту
  requestNotifyPermission();  // спросить разрешение на уведомления
  if (timers.has(btn)) return;
  const total = +btn.dataset.sec;
  const endAt = Date.now() + total * 1000;
  btn.classList.remove("done");
  btn.classList.add("running");
  const tick = () => {
    const left = Math.round((endAt - Date.now()) / 1000);
    if (left <= 0) { finishTimer(btn); return; }
    btn.textContent = "⏸ " + fmtClock(left);
  };
  tick();
  timers.set(btn, setInterval(tick, 1000));
}
function bindTimers() {
  document.querySelectorAll(".timer-btn").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => handleTimerClick(btn));
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
  btn.classList.add("done", "ringing");
  btn.textContent = "🔔 Стоп";
  ringingBtns.add(btn);
  startAlarm();
  const title = state.current ? state.current.title : "Рецепт";
  const li = btn.closest(".step-item");
  if (btn.dataset.name) {
    notify(btn.dataset.name, "");          // уведомление — только твоё слово
    toast("🔔 " + btn.dataset.name);
  } else if (li && li.dataset.stepno) {
    notify(title, "Шаг " + li.dataset.stepno + " готов");
    toast("🔔 " + title + " · шаг " + li.dataset.stepno);
  } else {
    notify(title, "Таймер готов");
    toast("🔔 " + title);
  }
}

// Свой (произвольный) таймер на странице рецепта
function addCustomTimer() {
  const min = parseInt(document.getElementById("ctMin").value, 10) || 0;
  const sec = parseInt(document.getElementById("ctSec").value, 10) || 0;
  const total = min * 60 + sec;
  if (total <= 0) { toast("Укажи время таймера"); return; }
  const name = (document.getElementById("ctName").value || "").trim();
  startCustomTimer(total, name);
  document.getElementById("ctMin").value = "";
  document.getElementById("ctSec").value = "";
  document.getElementById("ctName").value = "";
}
function startCustomTimer(total, name) {
  const list = document.getElementById("ctList");
  if (!list) return;
  const chip = document.createElement("div");
  chip.className = "ct-chip";
  const label = document.createElement("span");
  label.className = "ct-name";
  label.textContent = name || "Таймер";
  const btn = document.createElement("button");
  btn.className = "timer-btn";
  btn.dataset.sec = total;
  if (name) btn.dataset.name = name;
  btn.dataset.bound = "1";
  btn.textContent = "⏱ " + fmtClock(total);
  btn.addEventListener("click", () => handleTimerClick(btn));
  const del = document.createElement("button");
  del.className = "ct-x";
  del.title = "Убрать таймер";
  del.textContent = "✕";
  del.addEventListener("click", () => { if (timers.has(btn)) stopTimer(btn); chip.remove(); });
  chip.appendChild(label);
  chip.appendChild(btn);
  chip.appendChild(del);
  list.appendChild(chip);
  startTimerBtn(btn); // запускаем сразу
}
// Единый AudioContext, создаётся/возобновляется по жесту (клик «старт таймера»)
let audioCtx = null;
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
}
// Один «звонок» — серия из трёх коротких сигналов
function ringOnce() {
  ensureAudio();
  try {
    const A = audioCtx;
    if (A) {
      const base = A.currentTime;
      [0, 0.17, 0.34].forEach((off) => {
        const o = A.createOscillator(), g = A.createGain();
        o.connect(g); g.connect(A.destination);
        o.type = "square"; o.frequency.value = 988;
        const t = base + off;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.6, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        o.start(t); o.stop(t + 0.15);
      });
    }
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate([300, 120, 300, 120, 300]);
}
// Будильник: звенит повторно, пока не нажмёшь «Стоп» (или 40 секунд)
let alarmIv = null, alarmStop = null;
function startAlarm() {
  if (alarmIv) return;
  ringOnce();
  alarmIv = setInterval(ringOnce, 1300);
  alarmStop = setTimeout(() => {
    ringingBtns.forEach((b) => { b.classList.remove("ringing"); b.textContent = "✅ Готово!"; });
    ringingBtns.clear();
    silenceAlarm();
  }, 40000);
}
function silenceAlarm() {
  if (alarmIv) { clearInterval(alarmIv); alarmIv = null; }
  if (alarmStop) { clearTimeout(alarmStop); alarmStop = null; }
}
function requestNotifyPermission() {
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch (e) {}
}
function notify(title, body) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const opt = { icon: "icons/icon-192.png", tag: "timer-" + Date.now() };
      if (body) opt.body = body;
      new Notification(title, opt);
    }
  } catch (e) {}
}
function shorten(s, n) { s = String(s); return s.length > n ? s.slice(0, n).trim() + "…" : s; }

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
// Разбор "Название — количество" (разделитель — длинное тире U+2014)
function parseIng(str) {
  str = String(str).trim();
  const i = str.indexOf("—");
  if (i < 0) return { name: str, amount: "" };
  return { name: str.slice(0, i).trim(), amount: str.slice(i + 1).trim() };
}
function normName(n) { return String(n).trim().toLowerCase().replace(/\s+/g, " "); }
function shoppingAmount(it) {
  const seen = [];
  (it.contribs || []).forEach((c) => { if (c.a && !seen.includes(c.a)) seen.push(c.a); });
  return seen.join(" + ");
}
function shoppingText(it) { const a = shoppingAmount(it); return a ? it.name + " — " + a : it.name; }
function dishesInCart() {
  const ids = [];
  store.shopping.forEach((it) => (it.contribs || []).forEach((c) => { if (c.r && !ids.includes(c.r)) ids.push(c.r); }));
  return ids;
}

function addToShopping(r, factor) {
  const checks = (store.checks[r.id] && store.checks[r.id].ing) || {};
  let added = 0;
  (r.ingredients || []).forEach((ing, idx) => {
    if (ing && typeof ing === "object") return;      // под-заголовок
    if (checks[idx]) return;                          // вычеркнутые — уже есть
    const { name, amount } = parseIng(scaleQty(String(ing), factor));
    const key = normName(name);
    let item = store.shopping.find((it) => normName(it.name) === key);
    if (!item) { item = { name, contribs: [] }; store.shopping.push(item); }
    if (!item.contribs.some((c) => c.r === r.id && c.a === amount)) {
      item.contribs.push({ r: r.id, a: amount }); added++;
    }
  });
  store.saveShopping();
  updateShoppingBadge();
  toast(added ? "Добавлено в список 🛒" : "Уже в списке");
}
function removeDish(id) {
  store.shopping.forEach((it) => { it.contribs = (it.contribs || []).filter((c) => c.r !== id); });
  store.shopping = store.shopping.filter((it) => (it.contribs || []).length);
  store.saveShopping();
  updateShoppingBadge();
  renderShopping();
}
function addDishFromCart(id) {
  const r = state.recipes.find((x) => x.id === id);
  if (r) { addToShopping(r, 1); renderShopping(); }
}
function updateShoppingBadge() {
  const n = store.shopping.length;
  els.shoppingBadge.hidden = n === 0;
  els.shoppingBadge.textContent = n;
}
function renderShopping() {
  const items = store.shopping;
  const dishIds = dishesInCart();
  const chips = dishIds.map((id) => {
    const r = state.recipes.find((x) => x.id === id);
    return `<span class="dish-chip">${esc(r ? r.title : id)}<button class="dish-x" data-rmdish="${esc(id)}" title="Убрать продукты этого блюда">✕</button></span>`;
  }).join("");
  const options = state.recipes
    .filter((r) => !dishIds.includes(r.id))
    .map((r) => `<option value="${esc(r.id)}">${esc(r.title)}</option>`).join("");
  const dishBar = `<div class="cart-dishes">${chips}<select id="addDishSel" class="dish-add"><option value="">＋ добавить блюдо…</option>${options}</select></div>`;

  els.shoppingView.innerHTML = `
    <div class="detail-top">
      <button class="back-btn" id="shBack">← К списку</button>
      ${items.length ? `<button class="act-btn" id="shClear">🗑 Очистить</button>` : ""}
    </div>
    <h1 class="detail-title">🛒 Список покупок</h1>
    ${dishBar}
    ${items.length
      ? `<ul class="ingredients-list shopping-list">${items.map((it, i) =>
          `<li class="check-item" data-sh="${i}"><span class="cbox"></span><span class="ctext">${esc(shoppingText(it))}</span><button class="sh-del" data-del="${i}" title="Удалить">✕</button></li>`).join("")}</ul>`
      : `<p class="empty">Список пуст. Открой рецепт и нажми «🛒 В список покупок», или добавь блюдо выше.</p>`}`;

  document.getElementById("shBack").addEventListener("click", () => { location.hash = "#"; });
  const clr = document.getElementById("shClear");
  if (clr) clr.addEventListener("click", () => {
    if (confirm("Очистить весь список покупок?")) { store.shopping = []; store.saveShopping(); updateShoppingBadge(); renderShopping(); }
  });
  const sel = document.getElementById("addDishSel");
  if (sel) sel.addEventListener("change", () => { if (sel.value) addDishFromCart(sel.value); });
  els.shoppingView.querySelectorAll(".dish-x").forEach((b) =>
    b.addEventListener("click", () => removeDish(b.dataset.rmdish)));
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
  clearAllTimers(); // при смене страницы глушим таймеры/звонок
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

initTheme();
load();
