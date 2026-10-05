// Админ-панель рецептов: #/admin (список, включая черновики), #/admin/new, #/admin/edit/<slug>.
// Работает только онлайн (без outbox); права проверяет сервер — здесь только скрываем лишнее.
import { MAIN_TAGS, WAKE_HINT_AFTER } from "../config.js";
import { els } from "./ui.js";
import { isAdmin } from "../core/store.js";
import * as endpoints from "../api/endpoints.js";
import { ApiError, NetworkError, imageUrl } from "../api/client.js";
import { refreshCatalog } from "../sync/catalog.js";
import { esc, toast, emojiFor } from "../lib/utils.js";

const FIELD_NAMES = {
  title: "Название", slug: "Адрес (slug)", category: "Категория", main: "Основные теги", tags: "Теги",
  image: "Фото", time: "Время", servings: "Порции", ingredients: "Ингредиенты", steps: "Шаги", status: "Статус",
};

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
  if (path === "/new") renderForm(null, seq);
  else if (m) renderForm(decodeURIComponent(m[1]), seq);
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
    <div class="search-box admin-search"><input id="adFilter" type="search" placeholder="Найти рецепт…" value="${esc(filter)}"></div>
    <div class="count" id="adCount"></div>
    <ul class="admin-list" id="adList"></ul>`;

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

  const r = recipe || { title: "", slug: "", category: { name: "" }, main: [], tags: [], image: null, time: "", servings: "", ingredients: [], steps: [], status: "DRAFT" };
  let image = r.image || null;

  els.adminView.innerHTML = `
    <div class="detail-top">
      <button class="back-btn" id="adBack">← К рецептам</button>
      ${recipe && recipe.status === "PUBLISHED" ? `<a class="act-btn" href="#/recipe/${encodeURIComponent(recipe.slug)}">Открыть на сайте</a>` : ""}
    </div>
    <h1 class="detail-title">${recipe ? "✏️ " + esc(recipe.title) : "＋ Новый рецепт"}</h1>
    <form id="recipeForm" class="form admin-form" novalidate>
      <div id="formMsg" class="form-msg" hidden></div>
      <label class="field">Название *<input name="title" class="ct-input" maxlength="200" value="${esc(r.title)}" required></label>
      <div class="field-row">
        <label class="field">Категория *<input name="category" class="ct-input" list="catList" maxlength="50" value="${esc(r.category.name)}" required>
          <datalist id="catList">${cats.map((c) => `<option value="${esc(c.name)}">`).join("")}</datalist></label>
        <label class="field">Время<input name="time" class="ct-input" maxlength="50" placeholder="40 мин, 1 ч 10 мин" value="${esc(r.time || "")}"></label>
        <label class="field">Порции<input name="servings" class="ct-input" maxlength="100" placeholder="4 порции" value="${esc(r.servings || "")}"></label>
      </div>
      <fieldset class="field"><legend>Основные теги * <span class="hint">(фильтр на главной)</span></legend>
        <div class="main-tags">${MAIN_TAGS.map((t) => `<label class="tag-check"><input type="checkbox" name="main" value="${esc(t)}"${r.main.includes(t) ? " checked" : ""}> ${esc(t)}</label>`).join("")}</div>
      </fieldset>
      <label class="field">Теги для поиска <span class="hint">(через запятую)</span><input name="tags" class="ct-input" value="${esc(r.tags.join(", "))}"></label>

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

      <div class="field-row">
        <label class="field">Статус<select name="status" class="ct-input">
          <option value="DRAFT"${r.status === "DRAFT" ? " selected" : ""}>Черновик (видно только админу)</option>
          <option value="PUBLISHED"${r.status === "PUBLISHED" ? " selected" : ""}>Опубликован</option>
        </select></label>
        <label class="field">Адрес (slug) <span class="hint">— пусто: из названия</span><input name="slug" class="ct-input" maxlength="100" placeholder="tort-napoleon" value="${esc(r.slug || "")}"></label>
      </div>
      <div class="detail-actions">
        <button class="tool-btn accent" type="submit" id="saveBtn">💾 Сохранить</button>
        <button class="tool-btn" type="button" id="cancelBtn">Отмена</button>
      </div>
    </form>`;

  const form = document.getElementById("recipeForm");
  const preview = document.getElementById("photoPreview");
  const drawPhoto = () => {
    preview.innerHTML = image ? `<img src="${esc(imageUrl(image))}" alt="">` : `<span class="photo-empty">Нет фото — будет эмодзи</span>`;
    document.getElementById("photoRemove").hidden = !image;
  };
  drawPhoto();
  const back = () => { location.hash = "#/admin"; };
  document.getElementById("adBack").addEventListener("click", back);
  document.getElementById("cancelBtn").addEventListener("click", back);
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
      status: form.status.value,
    };
    const slugVal = form.slug.value.trim();
    if (slugVal) input.slug = slugVal;

    const errs = [];
    if (!input.title) errs.push("Укажите название");
    if (!input.category) errs.push("Укажите категорию");
    if (!input.main.length) errs.push("Отметьте хотя бы один основной тег");
    if (!input.ingredients.some((i) => i.kind === "ITEM")) errs.push("Нужен хотя бы один ингредиент");
    if (!input.steps.some((s) => s.kind === "ITEM")) errs.push("Нужен хотя бы один шаг");
    if (errs.length) { msg(errs.join(" · "), "err"); return; }

    const btn = document.getElementById("saveBtn");
    btn.disabled = true;
    msg("Сохранение…", "info");
    try {
      const saved = recipe ? await endpoints.updateRecipe(recipe.id, input) : await endpoints.createRecipe(input);
      toast(saved.status === "PUBLISHED" ? "Сохранено и опубликовано ✅" : "Сохранено как черновик ✅");
      refreshCatalog().catch(() => {});
      back();
    } catch (err) {
      btn.disabled = false;
      if (err instanceof ApiError && err.details && err.details.length) {
        msg(err.details.map((d) => `${FIELD_NAMES[d.field.split(".")[0]] || d.field}: ${d.message}`).join(" · "), "err");
      } else {
        msg(err instanceof NetworkError ? "Нет связи с сервером — рецепт не сохранён" : err.message, "err");
      }
    }
  });

  function msg(text, kind) {
    const m = document.getElementById("formMsg");
    m.hidden = !text;
    m.textContent = text || "";
    m.className = "form-msg" + (kind ? " " + kind : "");
    if (text && kind === "err") m.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
