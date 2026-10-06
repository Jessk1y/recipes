// «Мои предложения»: #/my (список со статусами), #/my/new (предложить рецепт), #/my/edit/<id> (пока не одобрено).
// Работает только онлайн; права и лимиты проверяет сервер.
import { WAKE_HINT_AFTER } from "../config.js";
import { els } from "./ui.js";
import { getUser } from "../core/store.js";
import { mailEnabled } from "../core/serverConfig.js";
import * as endpoints from "../api/endpoints.js";
import { NetworkError, imageUrl } from "../api/client.js";
import { esc, toast, emojiFor } from "../lib/utils.js";
import { mountRecipeForm } from "./recipeForm.js";

let renderSeq = 0;
const view = () => els.accountView;
// при отключённой почте подтверждать нечем — требования нет (сервер считает всех подтверждёнными)
const verified = () => getUser()?.emailVerified !== false || !mailEnabled();
const toAccount = () => { location.hash = "#/account"; };

const STATUS = {
  PENDING: ["pending", "На модерации"],
  REJECTED: ["rejected", "Отклонён"],
  PUBLISHED: ["pub", "Опубликован"],
  DRAFT: ["draft", "Снят с публикации"],
};

export function renderMy(path) {
  const seq = ++renderSeq;
  if (!getUser()) {
    view().innerHTML = `
      <div class="detail-top"><button class="back-btn" id="myBack">← К списку</button></div>
      <p class="empty">Предлагать рецепты могут только вошедшие пользователи. <a href="#/account">Войти</a></p>`;
    document.getElementById("myBack").addEventListener("click", () => { location.hash = "#"; });
    return;
  }
  const m = path.match(/^\/edit\/(.+)$/);
  if (path === "/new") renderForm(null, seq);
  else if (m) renderForm(decodeURIComponent(m[1]), seq);
  else renderList(seq);
}

function loading(text) {
  view().innerHTML = `<p class="empty" id="myLoading">${esc(text)}</p>`;
  return setTimeout(() => {
    const el = document.getElementById("myLoading");
    if (el) el.textContent = text + " Сервер просыпается — это может занять до минуты.";
  }, WAKE_HINT_AFTER);
}

function showError(err, retry) {
  const msg = err instanceof NetworkError ? "Нет связи с сервером. Этот раздел работает только онлайн." : err.message;
  view().innerHTML = `
    <div class="detail-top"><button class="back-btn" id="myBack">← В аккаунт</button></div>
    <p class="empty">⚠️ ${esc(msg)}<br><br><button class="tool-btn" id="myRetry">Повторить</button></p>`;
  document.getElementById("myBack").addEventListener("click", toAccount);
  document.getElementById("myRetry").addEventListener("click", retry);
}

async function renderList(seq) {
  const hint = loading("Загрузка предложений…");
  let data;
  try {
    data = await endpoints.mySubmissions();
  } catch (e) {
    if (seq === renderSeq) showError(e, () => renderMy(""));
    return;
  } finally {
    clearTimeout(hint);
  }
  if (seq !== renderSeq) return;

  const canSubmit = verified();
  view().innerHTML = `
    <div class="detail-top">
      <button class="back-btn" id="myBack">← В аккаунт</button>
      ${canSubmit ? `<button class="tool-btn accent" id="myNew">＋ Предложить рецепт</button>` : ""}
    </div>
    <h1 class="detail-title">📨 Мои предложения</h1>
    ${canSubmit
      ? `<p class="auth-hint">Рецепт появится на сайте после проверки администратором. Пока он не одобрен, его можно править.
          Не больше ${esc(data.limitPerDay)} новых предложений в сутки.</p>`
      : `<div class="form-msg info">✉️ Чтобы предлагать рецепты, подтвердите e-mail — письмо со ссылкой отправлено при регистрации
          (отправить ещё раз можно в <a href="#/account">аккаунте</a>).</div>`}
    <ul class="admin-list" id="myList">
      ${data.items.map((r) => {
        const [cls, label] = STATUS[r.status] || ["draft", r.status];
        const img = r.image ? `<img src="${esc(imageUrl(r.image))}" alt="" loading="lazy">` : emojiFor({ main: r.main, category: r.category.name });
        const when = new Date(r.submittedAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
        const editable = canSubmit && (r.status === "PENDING" || r.status === "REJECTED");
        return `<li class="admin-row">
          <div class="recent-img admin-thumb">${img}</div>
          <div class="admin-info">
            <div class="admin-title">${esc(r.title)}</div>
            <div class="admin-sub"><span class="status-badge ${cls}">${esc(label)}</span> ${esc(r.category.name)} · отправлено ${esc(when)}</div>
            ${r.status === "REJECTED" && r.rejectReason ? `<div class="reject-reason">Причина: ${esc(r.rejectReason)}</div>` : ""}
            ${r.status === "REJECTED" ? `<div class="auth-hint small">Исправьте и отправьте снова — иначе через 30 дней без правок предложение удалится.</div>` : ""}
          </div>
          <div class="admin-btns">
            ${editable ? `<button class="act-btn" data-edit="${esc(r.id)}">✏️ ${r.status === "REJECTED" ? "Исправить" : "Изменить"}</button>` : ""}
            ${r.status === "PUBLISHED" ? `<a class="act-btn" href="#/recipe/${encodeURIComponent(r.slug)}">Открыть на сайте</a>` : ""}
          </div>
        </li>`;
      }).join("") || `<p class="empty">Вы пока ничего не предлагали</p>`}
    </ul>`;
  document.getElementById("myBack").addEventListener("click", toAccount);
  const nw = document.getElementById("myNew");
  if (nw) nw.addEventListener("click", () => { location.hash = "#/my/new"; });
  document.getElementById("myList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-edit]");
    if (b) location.hash = "#/my/edit/" + encodeURIComponent(b.dataset.edit);
  });
}

async function renderForm(id, seq) {
  if (!verified()) { toast("Подтвердите e-mail, чтобы предлагать рецепты"); location.hash = "#/my"; return; }
  const hint = loading(id ? "Загрузка предложения…" : "Подготовка формы…");
  let recipe = null, cats = [];
  try {
    [recipe, cats] = await Promise.all([id ? endpoints.mySubmission(id) : null, endpoints.categories().catch(() => [])]);
  } catch (e) {
    if (seq === renderSeq) showError(e, () => renderMy(id ? "/edit/" + encodeURIComponent(id) : "/new"));
    return;
  } finally {
    clearTimeout(hint);
  }
  if (seq !== renderSeq) return;
  if (recipe && recipe.status !== "PENDING" && recipe.status !== "REJECTED") {
    toast("Предложение уже рассмотрено — править его нельзя");
    location.hash = "#/my";
    return;
  }
  const rejected = recipe && recipe.status === "REJECTED";
  mountRecipeForm(view(), {
    mode: "user", recipe, cats,
    title: recipe ? "✏️ " + recipe.title : "＋ Предложить рецепт",
    notice: rejected
      ? `<div class="form-msg err">Отклонено: ${esc(recipe.rejectReason || "без пояснения")}. После исправления рецепт снова уйдёт на проверку.</div>`
      : "",
    backLabel: "← К предложениям", onBack: () => { location.hash = "#/my"; },
    saveLabel: recipe ? (rejected ? "📨 Отправить снова" : "💾 Сохранить") : "📨 Отправить на модерацию",
    save: (input) => (recipe ? endpoints.updateSubmission(recipe.id, input) : endpoints.submitRecipe(input)),
    onSaved: () => {
      toast(recipe ? (rejected ? "Отправлено на проверку ✅" : "Сохранено ✅") : "Отправлено на модерацию ✅");
      location.hash = "#/my";
    },
  });
}

