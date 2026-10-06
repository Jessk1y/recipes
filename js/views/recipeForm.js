// Общая форма рецепта: админка (#/admin/new, #/admin/edit/…), правка предложения админом при модерации
// и «Мои предложения» (#/my/new, #/my/edit/…). Режимы:
//   admin    — статус (черновик/опубликован) и slug;
//   moderate — админ правит предложение пользователя и публикует: статус всегда PUBLISHED, slug можно поправить;
//   user     — без slug и статуса, категория только из существующих.
import { MAIN_TAGS } from "../config.js";
import * as endpoints from "../api/endpoints.js";
import { ApiError, NetworkError, imageUrl } from "../api/client.js";
import { esc } from "../lib/utils.js";

const FIELD_NAMES = {
  title: "Название", slug: "Адрес (slug)", category: "Категория", main: "Основные теги", tags: "Теги",
  image: "Фото", time: "Время", servings: "Порции", ingredients: "Ингредиенты", steps: "Шаги", status: "Статус",
};

// Ингредиенты и шаги — по строке на пункт; строка «# Текст» — подзаголовок. Ингредиент: «Мука — 200 г».
const toLines = (arr, key) => arr.map((x) => (x.kind === "HEADER" ? "# " + x[key] : key === "name" && x.amount ? `${x.name} — ${x.amount}` : x[key])).join("\n");

function parseLines(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) =>
    l.startsWith("#") ? { kind: "HEADER", value: l.replace(/^#+\s*/, "") } : { kind: "ITEM", value: l });
}
function parseIngredients(text) {
  return parseLines(text).map(({ kind, value }) => {
    if (kind === "HEADER") return { kind, name: value };
    const m = value.match(/^(.+?)\s*—\s*(.*)$/) || value.match(/^(.+?)\s+[–-]\s+(.*)$/);
    return m ? { kind, name: m[1].trim(), amount: m[2].trim() || null } : { kind, name: value, amount: null };
  });
}
const parseSteps = (text) => parseLines(text).map(({ kind, value }) => ({ kind, text: value }));

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
 */
export function mountRecipeForm(host, o) {
  const mode = o.mode;
  const recipe = o.recipe;
  const r = recipe || { title: "", slug: "", category: { name: "" }, main: [], tags: [], image: null, time: "", servings: "", ingredients: [], steps: [], status: "DRAFT" };
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
    ${o.notice || ""}
    <form id="recipeForm" class="form admin-form" novalidate>
      <div id="formMsg" class="form-msg" hidden></div>
      <label class="field">Название *<input name="title" class="ct-input" maxlength="200" value="${esc(r.title)}" required></label>
      <div class="field-row">
        ${categoryField}
        <label class="field">Время<input name="time" class="ct-input" maxlength="50" placeholder="40 мин, 1 ч 10 мин" value="${esc(r.time || "")}"></label>
        <label class="field">Порции<input name="servings" class="ct-input" maxlength="100" placeholder="4 порции" value="${esc(r.servings || "")}"></label>
      </div>
      <fieldset class="field"><legend>Основные теги * <span class="hint">(фильтр на главной)</span></legend>
        <div class="main-tags">${MAIN_TAGS.map((t) => `<label class="tag-check"><input type="checkbox" name="main" value="${esc(t)}"${r.main.includes(t) ? " checked" : ""}> ${esc(t)}</label>`).join("")}</div>
      </fieldset>
      <label class="field">Теги для поиска <span class="hint">(через запятую${mode === "user" ? ", не больше 10" : ""})</span><input name="tags" class="ct-input" value="${esc(r.tags.join(", "))}"></label>

      <div class="field">Фото <span class="hint">(jpeg, png или webp, до 5 МБ)</span>
        <div class="photo-box">
          <div class="detail-hero photo-preview" id="photoPreview"></div>
          <div class="photo-btns">
            <label class="tool-btn file-btn">📷 Загрузить<input type="file" id="photoFile" accept="image/jpeg,image/png,image/webp" hidden></label>
            <button type="button" class="tool-btn" id="photoRemove">Убрать фото</button>
          </div>
        </div>
      </div>

      <label class="field">Ингредиенты * <span class="hint">— по строке: «Мука — 200 г»; «# Для соуса» — подзаголовок</span>
        <textarea name="ingredients" class="note-area admin-area" rows="10">${esc(toLines(r.ingredients, "name"))}</textarea></label>
      <label class="field">Шаги * <span class="hint">— по строке на шаг; «# Тесто» — подзаголовок; время в тексте («15 мин») даёт таймер</span>
        <textarea name="steps" class="note-area admin-area" rows="10">${esc(toLines(r.steps, "text"))}</textarea></label>

      ${statusRow}
      <div class="detail-actions">
        <button class="tool-btn accent" type="submit" id="saveBtn">${esc(o.saveLabel || "💾 Сохранить")}</button>
        <button class="tool-btn" type="button" id="cancelBtn">Отмена</button>
      </div>
    </form>`;

  const form = document.getElementById("recipeForm");
  const preview = document.getElementById("photoPreview");
  const msg = (text, kind) => {
    const m = document.getElementById("formMsg");
    m.hidden = !text;
    m.textContent = text || "";
    m.className = "form-msg" + (kind ? " " + kind : "");
    if (text && kind === "err") m.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const drawPhoto = () => {
    preview.innerHTML = image ? `<img src="${esc(imageUrl(image))}" alt="">` : `<span class="photo-empty">Нет фото — будет эмодзи</span>`;
    document.getElementById("photoRemove").hidden = !image;
  };
  drawPhoto();
  document.getElementById("rfBack").addEventListener("click", o.onBack);
  document.getElementById("cancelBtn").addEventListener("click", o.onBack);
  document.getElementById("photoRemove").addEventListener("click", () => { image = null; drawPhoto(); });
  document.getElementById("photoFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { msg("Файл больше 5 МБ", "err"); return; }
    preview.innerHTML = `<span class="photo-empty">Загрузка фото…</span>`;
    try {
      image = (await endpoints.uploadImage(file)).url;
      msg("");
    } catch (err) {
      msg("Фото не загрузилось: " + (err instanceof NetworkError ? "нет связи с сервером" : err.message), "err");
    }
    drawPhoto();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = {
      title: form.title.value.trim(),
      category: form.category.value.trim(),
      main: [...form.querySelectorAll('input[name="main"]:checked')].map((c) => c.value),
      tags: form.tags.value.split(",").map((t) => t.trim()).filter(Boolean),
      image,
      time: form.time.value.trim() || null,
      servings: form.servings.value.trim() || null,
      ingredients: parseIngredients(form.ingredients.value),
      steps: parseSteps(form.steps.value),
    };
    if (mode === "admin") input.status = form.status.value;
    if (mode === "moderate") input.status = "PUBLISHED";
    const slugVal = form.slug ? form.slug.value.trim() : "";
    if (slugVal) input.slug = slugVal;

    const errs = [];
    if (!input.title) errs.push("Укажите название");
    if (!input.category) errs.push(mode === "user" ? "Выберите категорию" : "Укажите категорию");
    if (!input.main.length) errs.push("Отметьте хотя бы один основной тег");
    if (mode === "user" && input.tags.length > 10) errs.push("Не больше 10 тегов");
    if (!input.ingredients.some((i) => i.kind === "ITEM")) errs.push("Нужен хотя бы один ингредиент");
    if (!input.steps.some((s) => s.kind === "ITEM")) errs.push("Нужен хотя бы один шаг");
    if (errs.length) { msg(errs.join(" · "), "err"); return; }

    const btn = document.getElementById("saveBtn");
    btn.disabled = true;
    msg("Сохранение…", "info");
    try {
      o.onSaved(await o.save(input));
    } catch (err) {
      btn.disabled = false;
      if (err instanceof ApiError && err.details && err.details.length) {
        msg(err.details.map((d) => `${FIELD_NAMES[d.field.split(".")[0]] || d.field}: ${d.message}`).join(" · "), "err");
      } else {
        msg(err instanceof NetworkError ? "Нет связи с сервером — рецепт не сохранён" : err.message, "err");
      }
    }
  });
}

