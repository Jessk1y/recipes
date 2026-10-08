// Общая форма рецепта: админка (#/admin/new, #/admin/edit/…), правка предложения админом при модерации
// и «Мои предложения» (#/my/new, #/my/edit/…). Режимы:
//   admin    — статус (черновик/опубликован) и slug;
//   moderate — админ правит предложение пользователя и публикует: статус всегда PUBLISHED, slug можно поправить;
//   user     — без slug и статуса, категория только из существующих.
import { MAIN_TAGS } from "../config.js";
import * as endpoints from "../api/endpoints.js";
import { ApiError, NetworkError, imageUrl } from "../api/client.js";
import { esc } from "../lib/utils.js";
import { getCatalog, getUser } from "../core/store.js";
import { draftStore as LS, draftKey, contentKey, syncDraft, loadDraft, clearDraft, draftRecipe } from "../lib/formDraft.js";
import { mountTurnstile } from "../lib/turnstile.js";
import { buildSuggestions, suggest, norm } from "../lib/suggest.js";
import { UNITS, ingredientRows, ingredientsOut, stepRows, stepsOut, hasTime, recipeHints } from "../lib/recipeFields.js";
import { fromApi } from "../sync/catalog.js";
import { mountRecipeView } from "./recipeView.js";
import { clearAllTimers, bindTimers, addCustomTimer, startCustomTimer } from "./timers.js";

const FIELD_NAMES = {
  title: "Название", slug: "Адрес (slug)", category: "Категория", main: "Основные теги", tags: "Теги",
  image: "Фото", time: "Время", servings: "Порции", ingredients: "Ингредиенты", steps: "Шаги", status: "Статус",
};

// Подсказки продуктов: словарь корзины + названия ингредиентов из каталога, без дублей
function productSuggestions() {
  const raw = [];
  for (const rec of getCatalog().recipes) {
    for (const i of rec.ingredients) if (typeof i === "string") raw.push(i.split(" — ")[0]);
  }
  return buildSuggestions(raw);
}

const TXT = 'spellcheck="true" lang="ru" autocapitalize="sentences"';

/**
 * @param host      элемент, в который рисуем форму
 * @param o.recipe  редактируемый рецепт или null (новый)
 * @param o.cats    категории [{name}]
 * @param o.mode    "admin" | "moderate" | "user"
 * @param o.title   заголовок страницы
 * @param o.backLabel / o.onBack   кнопка «назад»
 * @param o.save    async (input) → сохранённый рецепт
 * @param o.onSaved (saved) — что делать после успеха
 * @param o.notice  html-плашка над формой (например, «Предложил: …»)
 * @param o.saveLabel подпись кнопки сохранения
 * @param o.secondary {label, save, onSaved} — вторая кнопка «сохранить без публикации»: после успеха форма остаётся открытой
 * @param o.restored / o.baselineKey  служебные: повторный вызов с восстановленным черновиком (см. lib/formDraft.js)
 * @param o.captchaKey публичный ключ Turnstile — если задан, перед отправкой нужно пройти «я не робот» (новое предложение)
 */
export function mountRecipeForm(host, o) {
  const mode = o.mode;
  const recipe = o.recipe;
  const dKey = draftKey({ uid: getUser()?.id, mode, id: recipe?.id });
  const r = o.restored ? draftRecipe(recipe, o.restored.input) : recipe || { title: "", slug: "", category: { name: "" }, main: [], tags: [], image: null, time: "", servings: "", ingredients: [], steps: [], status: "DRAFT" };
  let image = r.image || null;

  const catNames = o.cats.map((c) => c.name);
  if (r.category.name && !catNames.includes(r.category.name)) catNames.push(r.category.name);
  const categoryField = mode === "user"
    ? `<label class="field">Категория *<select name="category" class="ct-input" required>
        <option value="">— выберите —</option>
        ${catNames.map((n) => `<option value="${esc(n)}"${n === r.category.name ? " selected" : ""}>${esc(n)}</option>`).join("")}
      </select></label>`
    : `<label class="field">Категория *<input name="category" class="ct-input" list="catList" maxlength="50" value="${esc(r.category.name)}" required>
        <datalist id="catList">${catNames.map((n) => `<option value="${esc(n)}">`).join("")}</datalist></label>`;

  const statusRow = mode === "admin"
    ? `<div class="field-row">
        <label class="field">Статус<select name="status" class="ct-input">
          <option value="DRAFT"${r.status === "DRAFT" ? " selected" : ""}>Черновик (видно только админу)</option>
          <option value="PUBLISHED"${r.status === "PUBLISHED" ? " selected" : ""}>Опубликован</option>
        </select></label>
        <label class="field">Адрес (slug) <span class="hint">— пусто: из названия</span><input name="slug" class="ct-input" maxlength="100" placeholder="tort-napoleon" value="${esc(r.slug || "")}"></label>
      </div>`
    : mode === "moderate"
      ? `<div class="field-row">
          <label class="field">Адрес (slug)<input name="slug" class="ct-input" maxlength="100" value="${esc(r.slug || "")}"></label>
        </div>`
      : "";

  host.innerHTML = `
    <div class="detail-top">
      <button class="back-btn" id="rfBack">${esc(o.backLabel)}</button>
      ${o.topExtra || ""}
    </div>
    <h1 class="detail-title">${esc(o.title)}</h1>
    <div class="rf-modes" role="group" aria-label="Режим">
      <button type="button" class="rf-mode active" data-mode="edit" aria-pressed="true">✏️ Редактор</button>
      <button type="button" class="rf-mode" data-mode="preview" aria-pressed="false">👁 Предпросмотр</button>
    </div>
    <div class="rf-split" id="rfSplit" data-mode="edit">
    <div class="rf-edit">
    ${o.notice || ""}
    <div id="draftBox"></div>
    <form id="recipeForm" class="form admin-form" novalidate>
      <div id="formMsg" class="form-msg" hidden></div>
      <label class="field">Название *<input name="title" class="ct-input" ${TXT} maxlength="200" value="${esc(r.title)}" required></label>
      <div class="field-row">
        ${categoryField}
        <label class="field">Время<input name="time" class="ct-input" maxlength="50" placeholder="40 мин, 1 ч 10 мин" value="${esc(r.time || "")}"></label>
        <label class="field">Порции<input name="servings" class="ct-input" ${TXT} maxlength="100" placeholder="4 порции" value="${esc(r.servings || "")}"></label>
      </div>
      <fieldset class="field"><legend>Основные теги * <span class="hint">(фильтр на главной)</span></legend>
        <div class="main-tags">${MAIN_TAGS.map((t) => `<label class="tag-check"><input type="checkbox" name="main" value="${esc(t)}"${r.main.includes(t) ? " checked" : ""}> ${esc(t)}</label>`).join("")}</div>
      </fieldset>
      <label class="field">Теги для поиска <span class="hint">(через запятую${mode === "user" ? ", не больше 10" : ""})</span><input name="tags" class="ct-input" ${TXT} value="${esc(r.tags.join(", "))}"></label>

      <div class="field">Фото <span class="hint">(jpeg, png или webp, до 5 МБ)</span>
        <div class="photo-box">
          <div class="detail-hero photo-preview" id="photoPreview"></div>
          <div class="photo-btns">
            <label class="tool-btn file-btn">📷 Загрузить<input type="file" id="photoFile" accept="image/jpeg,image/png,image/webp" hidden></label>
            <button type="button" class="tool-btn" id="photoRemove">Убрать фото</button>
          </div>
        </div>
      </div>

      <div class="field">Ингредиенты *
        <div id="ingList" class="rows"></div>
        <div class="rows-add">
          <button type="button" class="tool-btn" id="ingAdd">＋ Ингредиент</button>
          <button type="button" class="tool-btn" id="ingAddH">＋ Подзаголовок</button>
        </div>
      </div>
      <div class="field">Шаги * <span class="hint">— время в тексте («15 мин») даёт таймер</span>
        <div id="stepList" class="rows"></div>
        <div class="rows-add">
          <button type="button" class="tool-btn" id="stepAdd">＋ Шаг</button>
          <button type="button" class="tool-btn" id="stepAddH">＋ Подзаголовок</button>
        </div>
      </div>

      ${statusRow}
      ${o.captchaKey ? `<div id="captchaBox" class="captcha-box"></div>` : ""}
      <div class="detail-actions">
        ${o.secondary ? `<button class="tool-btn" type="button" id="saveEditsBtn">${esc(o.secondary.label)}</button>` : ""}
        <button class="tool-btn accent" type="submit" id="saveBtn">${esc(o.saveLabel || "💾 Сохранить")}</button>
        <button class="tool-btn" type="button" id="cancelBtn">Отмена</button>
      </div>
    </form>
    </div>
    <aside class="rf-prev" aria-label="Предпросмотр">
      <div class="rf-prev-label">Так рецепт увидят на сайте <span class="hint">— ничего не сохраняется</span></div>
      <div id="rfPreview" class="rf-prev-body"></div>
      <div id="rfHints" class="rf-hints"></div>
    </aside>
    </div>`;

  const form = document.getElementById("recipeForm");
  let captcha = null;
  const captchaBox = document.getElementById("captchaBox");
  if (captchaBox) {
    captcha = mountTurnstile(captchaBox, o.captchaKey);
    captcha.ready.catch((err) => msg(err.message, "err"));
  }
  const preview = document.getElementById("photoPreview");
  const msg = (text, kind) => {
    const m = document.getElementById("formMsg");
    m.hidden = !text;
    m.textContent = text || "";
    m.className = "form-msg" + (kind ? " " + kind : "");
    if (text && kind === "err") m.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  let localPhoto = null; // object URL выбранного файла — показываем сразу, пока фото грузится на сервер
  const drawPhoto = () => {
    preview.innerHTML = localPhoto ? `<img src="${esc(localPhoto)}" alt="" class="uploading">`
      : image ? `<img src="${esc(imageUrl(image))}" alt="">` : `<span class="photo-empty">Нет фото — будет эмодзи</span>`;
    document.getElementById("photoRemove").hidden = !image && !localPhoto;
    schedulePreview();
  };
  document.getElementById("rfBack").addEventListener("click", o.onBack);
  document.getElementById("cancelBtn").addEventListener("click", o.onBack);
  document.getElementById("photoRemove").addEventListener("click", () => { image = null; localPhoto = null; drawPhoto(); });
  document.getElementById("photoFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { msg("Файл больше 5 МБ", "err"); return; }
    const local = URL.createObjectURL(file);
    localPhoto = local;
    drawPhoto();
    try {
      image = (await endpoints.uploadImage(file)).url;
      msg("");
    } catch (err) {
      msg("Фото не загрузилось: " + (err instanceof NetworkError ? "нет связи с сервером" : err.message), "err");
    }
    if (localPhoto === local) localPhoto = null;
    URL.revokeObjectURL(local);
    drawPhoto();
  });

  // ---------- Редакторы ингредиентов и шагов ----------
  const ing = ingredientRows(r.ingredients);
  const steps = stepRows(r.steps);
  const unitOptions = (unit) => {
    const list = unit && !UNITS.includes(unit) ? [...UNITS, unit] : UNITS;
    return `<option value=""${unit ? "" : " selected"}>—</option>` +
      list.map((u) => `<option value="${esc(u)}"${u === unit ? " selected" : ""}>${esc(u)}</option>`).join("");
  };
  const ctrls = (i, n) => `<div class="row-ctrls">
      <button type="button" class="row-btn" data-act="up" aria-label="Выше"${i === 0 ? " disabled" : ""}>↑</button>
      <button type="button" class="row-btn" data-act="down" aria-label="Ниже"${i === n - 1 ? " disabled" : ""}>↓</button>
      <button type="button" class="row-btn del" data-act="del" aria-label="Удалить">✕</button></div>`;
  const drawIng = () => {
    document.getElementById("ingList").innerHTML = ing.map((x, i) => x.h
      ? `<div class="row row-h" data-i="${i}"><input class="ct-input" data-f="name" ${TXT} maxlength="200" placeholder="Подзаголовок, например «Для соуса»" value="${esc(x.name)}">${ctrls(i, ing.length)}</div>`
      : `<div class="row row-ing" data-i="${i}">
          <input class="ct-input ing-name" data-f="name" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" ${TXT} maxlength="200" placeholder="Продукт" value="${esc(x.name)}">
          <input class="ct-input ing-qty" data-f="qty" inputmode="decimal" maxlength="20" placeholder="Кол-во" value="${esc(x.qty)}">
          <select class="ct-input ing-unit" data-f="unit" aria-label="Единица">${unitOptions(x.unit)}</select>
          ${ctrls(i, ing.length)}</div>`).join("");
  };
  const drawSteps = () => {
    let n = 0;
    document.getElementById("stepList").innerHTML = steps.map((x, i) => x.h
      ? `<div class="row row-h" data-i="${i}"><input class="ct-input" data-f="text" ${TXT} maxlength="2000" placeholder="Подзаголовок, например «Крем»" value="${esc(x.text)}">${ctrls(i, steps.length)}</div>`
      : `<div class="row row-step" data-i="${i}">
          <div class="step-head"><span class="step-num">Шаг ${++n}</span><span class="step-time" ${hasTime(x.text) ? "" : "hidden"}>⏱ таймер</span>${ctrls(i, steps.length)}</div>
          <textarea class="ct-input" data-f="text" ${TXT} rows="3" maxlength="2000" placeholder="Что сделать">${esc(x.text)}</textarea></div>`).join("");
  };
  const editor = (id, arr, draw) => {
    const box = document.getElementById(id);
    box.addEventListener("input", (e) => {
      const row = e.target.closest(".row");
      if (!row || !e.target.dataset.f) return;
      arr[+row.dataset.i][e.target.dataset.f] = e.target.value;
      if (e.target.tagName === "TEXTAREA") row.querySelector(".step-time").hidden = !hasTime(e.target.value);
    });
    box.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const i = +btn.closest(".row").dataset.i;
      const act = btn.dataset.act;
      if (act === "del") arr.splice(i, 1);
      else { const j = act === "up" ? i - 1 : i + 1; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; }
      draw();
    });
  };
  const addRow = (arr, draw, id, row) => {
    arr.push(row);
    draw();
    const el = document.getElementById(id).lastElementChild.querySelector("input,textarea");
    el.focus();
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const newIng = () => ({ h: false, name: "", qty: "", unit: "", orig: null, origQty: "", origUnit: "" });
  const newStep = () => ({ h: false, text: "", timerSeconds: null, origText: "" });
  if (!ing.length) ing.push(newIng());
  if (!steps.length) steps.push(newStep());
  drawIng();
  drawSteps();
  editor("ingList", ing, drawIng);
  editor("stepList", steps, drawSteps);

  // Свой выпадающий список названий продуктов (вместо datalist): ↑↓/Enter/Esc, тап, закрытие по клику вне
  const entries = productSuggestions();
  const box = document.createElement("ul");
  box.className = "sugg";
  box.id = "suggBox";
  box.setAttribute("role", "listbox");
  box.hidden = true;
  host.appendChild(box);
  let cur = null, items = [], active = -1; // cur — поле названия, к которому привязан список
  const closeSugg = () => {
    box.hidden = true;
    if (cur) cur.setAttribute("aria-expanded", "false");
    cur = null; items = []; active = -1;
  };
  const place = () => {
    if (!cur) return;
    const rc = cur.getBoundingClientRect();
    box.style.left = rc.left + "px";
    box.style.width = rc.width + "px";
    const below = innerHeight - rc.bottom, need = Math.min(box.scrollHeight, 8 * 46) + 8;
    // не помещается снизу (клавиатура на телефоне) — открываем над полем
    if (below < need && rc.top > below) { box.style.top = "auto"; box.style.bottom = innerHeight - rc.top + 4 + "px"; }
    else { box.style.bottom = "auto"; box.style.top = rc.bottom + 4 + "px"; }
  };
  const markActive = () => {
    [...box.children].forEach((li, k) => {
      li.classList.toggle("active", k === active);
      li.setAttribute("aria-selected", k === active ? "true" : "false");
    });
    if (active >= 0) box.children[active].scrollIntoView({ block: "nearest" });
  };
  const openSugg = (input) => {
    cur = input;
    items = suggest(entries, input.value);
    active = -1;
    if (!items.length) { closeSugg(); return; }
    const q = norm(input.value);
    box.innerHTML = items.map((e, k) => {
      const at = norm(e.name).indexOf(q);
      const label = at < 0 ? esc(e.name)
        : esc(e.name.slice(0, at)) + "<mark>" + esc(e.name.slice(at, at + q.length)) + "</mark>" + esc(e.name.slice(at + q.length));
      return `<li role="option" data-k="${k}">${label}</li>`;
    }).join("");
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
    place();
  };
  const pick = (k) => {
    const input = cur;
    if (!input || !items[k]) return;
    input.value = items[k].name;
    ing[+input.closest(".row").dataset.i].name = items[k].name;
    schedulePreview();
    closeSugg();
    const qty = input.closest(".row").querySelector(".ing-qty");
    if (qty) qty.focus();
  };
  const ingBox = document.getElementById("ingList");
  const isName = (t) => t.classList && t.classList.contains("ing-name");
  ingBox.addEventListener("input", (e) => { if (isName(e.target)) openSugg(e.target); });
  ingBox.addEventListener("focusin", (e) => { if (isName(e.target) && e.target.value) openSugg(e.target); });
  ingBox.addEventListener("keydown", (e) => {
    if (!isName(e.target) || box.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      markActive();
    } else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(active); }
    else if (e.key === "Escape") { e.preventDefault(); closeSugg(); }
    else if (e.key === "Tab") closeSugg();
  });
  // pointerdown + preventDefault: поле не теряет фокус, на телефоне не дёргается клавиатура
  box.addEventListener("pointerdown", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    e.preventDefault();
    pick(+li.dataset.k);
  });
  const outside = (e) => {
    if (!form.isConnected) { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); return; }
    if (cur && e.target !== cur && !box.contains(e.target)) closeSugg();
  };
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
  ingBox.addEventListener("click", (e) => { if (e.target.closest("button")) closeSugg(); }, true); // ↑↓/✕ перерисовывают список строк — подсказки закрыть
  document.getElementById("ingAdd").addEventListener("click", () => addRow(ing, drawIng, "ingList", newIng()));
  document.getElementById("ingAddH").addEventListener("click", () => addRow(ing, drawIng, "ingList", { h: true, name: "" }));
  document.getElementById("stepAdd").addEventListener("click", () => addRow(steps, drawSteps, "stepList", newStep()));
  document.getElementById("stepAddH").addEventListener("click", () => addRow(steps, drawSteps, "stepList", { h: true, text: "" }));

  // Текущее содержимое формы в формате API — для сохранения и для предпросмотра
  const collect = () => {
    const input = {
      title: form.title.value.trim(),
      category: form.category.value.trim(),
      main: [...form.querySelectorAll('input[name="main"]:checked')].map((c) => c.value),
      tags: form.tags.value.split(",").map((t) => t.trim()).filter(Boolean),
      image,
      time: form.time.value.trim() || null,
      servings: form.servings.value.trim() || null,
      ingredients: ingredientsOut(ing),
      steps: stepsOut(steps),
    };
    if (mode === "admin") input.status = form.status.value;
    if (mode === "moderate") input.status = "PUBLISHED";
    const slugVal = form.slug ? form.slug.value.trim() : "";
    if (slugVal) input.slug = slugVal;
    return input;
  };

  // ---------- Предпросмотр: тот же код страницы рецепта (recipeView.js), без побочных эффектов ----------
  const split = document.getElementById("rfSplit");
  const prevHost = document.getElementById("rfPreview");
  const hintsHost = document.getElementById("rfHints");
  const wide = matchMedia("(min-width: 1000px)"); // рядом с формой; на узком экране — переключатель
  let lastKey = "", prevTimer = null;
  const previewVisible = () => wide.matches || split.dataset.mode === "preview";
  const refreshPreview = (force) => {
    if (!form.isConnected || !previewVisible()) return;
    const input = collect();
    const photo = localPhoto || input.image; // до загрузки на сервер показываем локальный файл
    const rec = fromApi({ ...input, slug: input.slug || "preview", title: input.title || "Без названия",
      category: { name: input.category }, image: photo });
    const hints = recipeHints({ ...input, image: photo, ing, steps });
    const key = JSON.stringify([rec, hints]);
    if (!force && key === lastKey) return;
    lastKey = key;
    clearAllTimers(); // старая страница уходит — её таймеры не должны звонить
    mountRecipeView(prevHost, rec, { preview: true, timers: { bind: bindTimers, addCustom: addCustomTimer, startCustom: startCustomTimer } });
    hintsHost.innerHTML = hints.length
      ? `<div class="rf-hints-title">Что поправить</div><ul>${hints.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>`
      : `<div class="rf-hints-ok">✅ Недочётов не видно</div>`;
  };
  function schedulePreview() {
    clearTimeout(prevTimer);
    prevTimer = setTimeout(() => refreshPreview(false), 300);
  }
  form.addEventListener("input", schedulePreview);
  form.addEventListener("change", schedulePreview);
  form.addEventListener("click", schedulePreview); // ↑↓ ✕ ＋ перерисовывают строки без события input
  const setMode = (m) => {
    split.dataset.mode = m;
    host.querySelectorAll(".rf-mode").forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    if (m === "preview") { refreshPreview(true); window.scrollTo(0, 0); }
    else if (!wide.matches) clearAllTimers(); // форма скрывает предпросмотр — не оставляем звонящие таймеры
  };
  host.querySelectorAll(".rf-mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  wide.addEventListener("change", () => refreshPreview(true));
  drawPhoto();
  refreshPreview(true);

  // ---------- Автосохранение несохранённой формы (localStorage) ----------
  let baseline = o.baselineKey ?? contentKey(collect()); // содержимое исходного рецепта (до правок и до черновика)
  let curBase = recipe?.updatedAt || null; // версия рецепта на сервере, с которой начали править
  let deciding = !o.restored && !!loadDraft(LS, dKey, baseline); // пока пользователь не выбрал «восстановить/удалить», старый черновик не затираем
  let saveTimer = null, closed = false;
  const flush = () => {
    clearTimeout(saveTimer);
    if (closed || deciding || !form.isConnected) return;
    syncDraft(LS, dKey, collect(), baseline, curBase);
  };
  const scheduleDraft = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 800); };
  form.addEventListener("input", scheduleDraft);
  form.addEventListener("change", scheduleDraft);
  form.addEventListener("click", scheduleDraft);
  const onHide = () => {
    if (!form.isConnected) { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", onHide); return; }
    if (document.visibilityState === "hidden" || document.visibilityState === undefined) flush();
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", flush);
  const draftBox = document.getElementById("draftBox");
  const when = (t) => new Date(t).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  if (o.restored) {
    const d = o.restored;
    const stale = d.base && recipe?.updatedAt && d.base !== recipe.updatedAt;
    draftBox.innerHTML = `<div class="form-msg info">♻️ Восстановлен несохранённый черновик от ${esc(when(d.savedAt))}.${stale ? " Рецепт на сервере изменился после этого — проверьте поля перед сохранением." : ""}
      <button type="button" class="act-btn" id="draftDrop">Вернуть сохранённую версию</button></div>`;
    document.getElementById("draftDrop").addEventListener("click", () => {
      closed = true; clearDraft(LS, dKey);
      mountRecipeForm(host, { ...o, restored: null, baselineKey: null });
    });
  } else if (deciding) {
    const d = loadDraft(LS, dKey, baseline);
    draftBox.innerHTML = `<div class="form-msg info">📝 Есть несохранённый черновик от ${esc(when(d.savedAt))}. Пока вы не выбрали, новые правки не сохраняются.
      <button type="button" class="act-btn" id="draftRestore">Восстановить</button>
      <button type="button" class="act-btn danger" id="draftDiscard">Удалить</button></div>`;
    document.getElementById("draftRestore").addEventListener("click", () => {
      closed = true;
      mountRecipeForm(host, { ...o, restored: d, baselineKey: baseline });
    });
    document.getElementById("draftDiscard").addEventListener("click", () => {
      clearDraft(LS, dKey); deciding = false; draftBox.innerHTML = "";
    });
  }

  // ---------- Сохранение ----------
  const buttons = () => [document.getElementById("saveBtn"), document.getElementById("saveEditsBtn")].filter(Boolean);
  // stay: после успеха форма остаётся (вторая кнопка) — тогда исходным считается сохранённое
  async function run(saver, onSaved, stay) {
    const input = collect();

    const errs = [];
    if (!input.title) errs.push("Укажите название");
    if (!input.category) errs.push(mode === "user" ? "Выберите категорию" : "Укажите категорию");
    if (!input.main.length) errs.push("Отметьте хотя бы один основной тег");
    if (mode === "user" && input.tags.length > 10) errs.push("Не больше 10 тегов");
    if (!input.ingredients.some((i) => i.kind === "ITEM")) errs.push("Нужен хотя бы один ингредиент");
    if (!input.steps.some((s) => s.kind === "ITEM")) errs.push("Нужен хотя бы один шаг");
    if (errs.length) { msg(errs.join(" · "), "err"); return; }
    if (captcha) {
      if (!captcha.token()) { msg("Подтвердите, что вы не робот", "err"); return; }
      input.turnstileToken = captcha.token();
    }

    buttons().forEach((b) => { b.disabled = true; });
    msg("Сохранение…", "info");
    try {
      const saved = await saver(input);
      closed = true; clearTimeout(saveTimer); clearDraft(LS, dKey); // сервер принял — черновик больше не нужен
      if (stay) {
        closed = false; deciding = false; draftBox.innerHTML = "";
        curBase = saved?.updatedAt || curBase;
        baseline = contentKey(collect());
        msg("");
        buttons().forEach((b) => { b.disabled = false; });
      }
      onSaved(saved);
    } catch (err) {
      buttons().forEach((b) => { b.disabled = false; });
      if (captcha) captcha.reset(); // токен одноразовый — после любой неудачи нужен новый
      if (err instanceof ApiError && err.details && err.details.length) {
        msg(err.details.map((d) => `${FIELD_NAMES[d.field.split(".")[0]] || d.field}: ${d.message}`).join(" · "), "err");
      } else {
        msg(err instanceof NetworkError ? "Нет связи с сервером — рецепт не сохранён" : err.message, "err");
      }
    }
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); run(o.save, o.onSaved, false); });
  const sec = document.getElementById("saveEditsBtn");
  if (sec) sec.addEventListener("click", () => run(o.secondary.save, o.secondary.onSaved, true));
}
