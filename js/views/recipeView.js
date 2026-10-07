// Разметка и поведение страницы рецепта — общие для самой страницы (detail.js) и для предпросмотра в редакторе.
// Предпросмотр (o.preview) ничего не сохраняет и не трогает хранилище: кнопки избранного, корзины, заметок,
// отметок и «поделиться» в нём отсутствуют или не подключены. Таймеры и масштаб порций работают как обычно.
// Зависимости с побочными эффектами (таймеры, действия) приходят параметрами — модуль сам их не импортирует.
import { esc, scaleQty, stepSeconds, fmtClock, emojiFor } from "../lib/utils.js";

function ingredientsHTML(r, factor, checks) {
  return (r.ingredients || []).map((i, idx) => {
    if (i && typeof i === "object" && i.h) return `<li class="sub-head">${esc(i.h)}</li>`;
    const txt = scaleQty(String(i), factor);
    const on = checks[idx] ? " checked" : "";
    return `<li class="check-item${on}" data-ing="${idx}"><span class="cbox"></span><span class="ctext">${esc(txt)}</span></li>`;
  }).join("");
}

function stepsHTML(r, checks) {
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

/**
 * @param r         рецепт в формате фронтенда (как в data/recipes.json)
 * @param o.preview true — предпросмотр: без кнопок избранного/корзины/«назад», заметки закрыты, отметок из хранилища нет
 * @param o.checks  {ing:{}, step:{}} — сохранённые отметки (в предпросмотре игнорируются)
 * @param o.fav / o.note — состояние избранного и заметка (в предпросмотре игнорируются)
 */
export function recipeViewHTML(r, o = {}) {
  const preview = !!o.preview;
  const checks = preview ? {} : (o.checks || {});
  const img = r.image ? `<img src="${esc(r.image)}" alt="${esc(r.title)}">` : emojiFor(r);
  const meta = [r.time, r.servings].filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join("");
  const allTags = [...new Set([...(r.main || []), ...(r.tags || [])])];
  const tags = allTags.map((t) => `<span class="mini-tag">${esc(t)}</span>`).join("");
  // id нужны только настоящей странице (на ней один такой блок); в предпросмотре рядом форма с такими же id
  const id = (name) => (preview ? "" : ` id="${name}"`);

  const top = preview ? "" : `
    <div class="detail-top">
      <button class="back-btn" id="back">← К списку</button>
      <div class="detail-actions">
        <button class="act-btn" id="favBtn">${o.fav ? "★ В избранном" : "☆ В избранное"}</button>
        <button class="act-btn" id="shareBtn">🔗 Поделиться</button>
        <button class="act-btn" id="printBtn">🖨️ Печать</button>
      </div>
    </div>`;
  const shopBtns = preview ? "" : `
      <button class="act-btn" id="toShopping">🛒 В список покупок</button>
      <button class="act-btn" id="resetBtn">↺ Сбросить отметки</button>`;
  const notes = preview
    ? `<textarea class="note-area" disabled placeholder="В предпросмотре заметки не сохраняются"></textarea>`
    : `<textarea id="noteArea" class="note-area" maxlength="2000" placeholder="Например: в следующий раз меньше соли…">${esc(o.note || "")}</textarea>`;

  return `${top}
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
      </div>${shopBtns}
    </div>

    <div class="detail-cols">
      <div class="panel">
        <h2>Ингредиенты <span class="hint">(нажми, чтобы вычеркнуть)</span></h2>
        <ul class="ingredients-list"${id("ingList")}>${ingredientsHTML(r, 1, checks.ing || {})}</ul>
      </div>
      <div class="panel">
        <h2>Приготовление</h2>
        <ol class="steps-list"${id("stepList")}>${stepsHTML(r, checks.step || {})}</ol>
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
      ${notes}
    </div>`;
}

/**
 * Рисует рецепт в root и вешает обработчики.
 * @param o.timers  {bind, addCustom, startCustom} — таймеры (views/timers.js)
 * @param o.preview предпросмотр: обработчиков хранилища/избранного/корзины нет вообще
 * @param o.fx      только для настоящей страницы: {back, fav, share, print, shop(factor), reset, note(text), check(kind, idx, on), factor(f)}
 * @param o.checks / o.fav / o.note — исходные данные настоящей страницы
 */
export function mountRecipeView(root, r, o) {
  const preview = !!o.preview;
  const fx = preview ? {} : (o.fx || {});
  root.innerHTML = recipeViewHTML(r, o);

  let factor = 1;
  const ingEl = root.querySelector(".ingredients-list");
  const bindChecks = () => {
    root.querySelectorAll(".ingredients-list .check-item").forEach((li) => {
      li.addEventListener("click", () => {
        li.classList.toggle("checked");
        if (fx.check) fx.check("ing", li.dataset.ing, li.classList.contains("checked"));
      });
    });
  };
  root.querySelectorAll(".srv").forEach((b) => {
    b.addEventListener("click", () => {
      factor = parseFloat(b.dataset.f);
      root.querySelectorAll(".srv").forEach((x) => x.classList.toggle("active", x === b));
      const cur = {}; // отметки берём с экрана: они могли измениться после отрисовки
      ingEl.querySelectorAll(".check-item.checked").forEach((li) => { cur[li.dataset.ing] = 1; });
      ingEl.innerHTML = ingredientsHTML(r, factor, cur);
      bindChecks();
      if (fx.factor) fx.factor(factor);
    });
  });
  root.querySelectorAll(".steps-list .step-item").forEach((li) => {
    li.querySelector(".step-text").addEventListener("click", () => {
      li.classList.toggle("checked");
      if (fx.check) fx.check("step", li.dataset.step, li.classList.contains("checked"));
    });
  });
  bindChecks();

  if (!preview) {
    const on = (sel, ev, fn) => { const el = root.querySelector(sel); if (el && fn) el.addEventListener(ev, fn); };
    on("#back", "click", fx.back);
    on("#favBtn", "click", fx.fav);
    on("#shareBtn", "click", fx.share);
    on("#printBtn", "click", fx.print);
    on("#toShopping", "click", () => fx.shop && fx.shop(factor));
    on("#resetBtn", "click", fx.reset);
    on("#noteArea", "input", (e) => fx.note && fx.note(e.target.value));
  }

  // свой таймер и таймеры шагов — как на настоящей странице
  const t = o.timers;
  root.querySelector("#ctStart").addEventListener("click", t.addCustom);
  root.querySelectorAll(".ct-preset").forEach((b) =>
    b.addEventListener("click", () => t.startCustom((+b.dataset.min) * 60, "")));
  ["#ctName", "#ctMin", "#ctSec"].forEach((sel) =>
    root.querySelector(sel).addEventListener("keydown", (e) => { if (e.key === "Enter") t.addCustom(); }));
  t.bind();
}
