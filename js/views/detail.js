// Страница рецепта: ингредиенты (масштаб порций, вычёркивание), шаги с таймерами, свой таймер, заметки.
import { state, els } from "./ui.js";
import { isFav, getData, getChecks } from "../core/store.js";
import * as actions from "../core/actions.js";
import { esc, scaleQty, stepSeconds, fmtClock, toast, emojiFor } from "../lib/utils.js";
import { bindTimers, addCustomTimer, startCustomTimer } from "./timers.js";
import { requestWake } from "./wake.js";
import { toggleFav } from "./list.js";
import { addToShopping } from "./shopping.js";

// ---------- Рендер карточки рецепта ----------
function ingredientsHTML(r, factor) {
  const checks = (getChecks()[r.id] && getChecks()[r.id].ing) || {};
  return (r.ingredients || []).map((i, idx) => {
    if (i && typeof i === "object" && i.h) return `<li class="sub-head">${esc(i.h)}</li>`;
    const txt = scaleQty(String(i), factor);
    const on = checks[idx] ? " checked" : "";
    return `<li class="check-item${on}" data-ing="${idx}"><span class="cbox"></span><span class="ctext">${esc(txt)}</span></li>`;
  }).join("");
}

function stepsHTML(r) {
  const checks = (getChecks()[r.id] && getChecks()[r.id].step) || {};
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


function renderDetail(id) {
  const r = state.recipes.find((x) => x.id === id);
  if (!r) { location.hash = "#"; return; }
  state.current = r;
  state.factor = 1;
  actions.pushRecent(id);

  const img = r.image ? `<img src="${esc(r.image)}" alt="${esc(r.title)}">` : emojiFor(r);
  const meta = [r.time, r.servings].filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join("");
  const allTags = [...new Set([...(r.main || []), ...(r.tags || [])])];
  const tags = allTags.map((t) => `<span class="mini-tag">${esc(t)}</span>`).join("");
  const fav = isFav(r.id);
  const note = getData().notes[r.id] || "";

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
      <textarea id="noteArea" class="note-area" maxlength="2000" placeholder="Например: в следующий раз меньше соли…">${esc(note)}</textarea>
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
    actions.resetChecks(r.id);
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
    actions.setNote(r.id, e.target.value);
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
      actions.toggleCheck(r.id, "ing", idx, li.classList.contains("checked"));
    });
  });
}
function bindStepChecks(r) {
  document.querySelectorAll("#stepList .step-item").forEach((li) => {
    li.querySelector(".step-text").addEventListener("click", () => {
      const idx = li.dataset.step;
      li.classList.toggle("checked");
      actions.toggleCheck(r.id, "step", idx, li.classList.contains("checked"));
    });
  });
}

// ---------- Поделиться ----------
async function shareRecipe(r) {
  const url = location.origin + location.pathname + "#/recipe/" + encodeURIComponent(r.id);
  const data = { title: r.title, text: "Рецепт: " + r.title, url };
  if (navigator.share) { try { await navigator.share(data); return; } catch (e) {} }
  try { await navigator.clipboard.writeText(url); toast("Ссылка скопирована 📋"); }
  catch (e) { prompt("Скопируй ссылку:", url); }
}

// Обновить кнопку избранного и заметку без перерисовки страницы (данные пришли с сервера/из другой вкладки):
// перерисовка сбросила бы запущенные таймеры.
function refreshDetailData() {
  const r = state.current;
  if (!r) return;
  const fav = isFav(r.id);
  const favBtn = document.getElementById("favBtn");
  if (favBtn) favBtn.textContent = fav ? "★ В избранном" : "☆ В избранное";
  const area = document.getElementById("noteArea");
  const note = getData().notes[r.id] || "";
  if (area && document.activeElement !== area && area.value !== note) area.value = note;
}

export { renderDetail, refreshDetailData };
