// Аккаунт (#/account): вход и регистрация для гостя, профиль и состояние синхронизации для вошедшего.
import { WAKE_HINT_AFTER } from "../config.js";
import { els } from "./ui.js";
import { getUser, getSync, isAdmin } from "../core/store.js";
import * as sync from "../sync/sync.js";
import { ApiError, NetworkError } from "../api/client.js";
import { esc, plural, toast } from "../lib/utils.js";

let mode = "login"; // login | register

// Кнопка в шапке: 👤 для гостя, первая буква имени для вошедшего; точка — есть неотправленные изменения
export function updateAccountBtn() {
  const user = getUser();
  const st = getSync();
  const btn = els.accountBtn;
  btn.classList.toggle("signed-in", !!user);
  btn.textContent = user ? (user.displayName || user.email).trim().charAt(0).toUpperCase() : "👤";
  btn.title = user ? `${user.displayName} — аккаунт` : "Войти";
  if (user && (st.pending > 0 || st.status === "offline" || st.status === "error")) {
    const dot = document.createElement("span");
    dot.className = "sync-dot" + (st.status === "offline" || st.status === "error" ? " off" : "");
    btn.appendChild(dot);
  }
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function syncText() {
  const st = getSync();
  const pending = st.pending
    ? ` · ждут отправки: ${st.pending}`
    : "";
  switch (st.status) {
    case "syncing": return "🔄 Синхронизация…" + pending;
    case "offline": return "📴 Нет связи с сервером — изменения сохранены на устройстве и отправятся позже" + pending;
    case "error": return "⚠️ Ошибка синхронизации, повторим позже" + pending;
    default:
      return (st.lastAt ? `✅ Синхронизировано в ${fmtTime(st.lastAt)}` : "Ещё не синхронизировано") + pending;
  }
}

export function renderAccount() {
  const user = getUser();
  if (user) return renderProfile(user);

  els.accountView.innerHTML = `
    <div class="detail-top"><button class="back-btn" id="accBack">← К списку</button></div>
    <div class="panel auth-panel">
      <div class="auth-tabs">
        <button class="tag-chip${mode === "login" ? " active" : ""}" data-mode="login">Вход</button>
        <button class="tag-chip${mode === "register" ? " active" : ""}" data-mode="register">Регистрация</button>
      </div>
      <p class="auth-hint">Войдите, чтобы избранное, заметки и список покупок были на всех ваших устройствах.
        То, что уже сохранено на этом устройстве, перенесётся в аккаунт.</p>
      <form id="authForm" class="form" novalidate>
        ${mode === "register" ? `<label class="field">Имя<input name="displayName" class="ct-input" autocomplete="nickname" maxlength="50" required></label>` : ""}
        <label class="field">E-mail<input name="email" type="email" class="ct-input" autocomplete="email" required></label>
        <label class="field">Пароль${mode === "register" ? ' <span class="hint">(не меньше 8 символов)</span>' : ""}
          <input name="password" type="password" class="ct-input" minlength="${mode === "register" ? 8 : 1}" maxlength="72"
            autocomplete="${mode === "register" ? "new-password" : "current-password"}" required></label>
        <div id="authMsg" class="form-msg" hidden></div>
        <button class="tool-btn accent" id="authSubmit" type="submit">${mode === "register" ? "Зарегистрироваться" : "Войти"}</button>
      </form>
    </div>`;

  document.getElementById("accBack").addEventListener("click", () => { location.hash = "#"; });
  els.accountView.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => { mode = b.dataset.mode; renderAccount(); }));
  document.getElementById("authForm").addEventListener("submit", onSubmit);
}

function showMsg(text, kind) {
  const m = document.getElementById("authMsg");
  if (!m) return;
  m.hidden = !text;
  m.textContent = text || "";
  m.className = "form-msg" + (kind ? " " + kind : "");
}

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const email = f.email.value.trim();
  const password = f.password.value;
  const name = f.displayName ? f.displayName.value.trim() : "";
  if (!email || !password || (mode === "register" && !name)) return showMsg("Заполните все поля", "err");
  if (mode === "register" && password.length < 8) return showMsg("Пароль — не меньше 8 символов", "err");

  const btn = document.getElementById("authSubmit");
  btn.disabled = true;
  showMsg("");
  const hint = setTimeout(() => showMsg("Сервер просыпается — это может занять до минуты…", "info"), WAKE_HINT_AFTER);
  try {
    if (mode === "register") await sync.register(email, password, name);
    else await sync.login(email, password);
    toast("Вы вошли ✅");
    // экран перерисуется по событию session.set
  } catch (err) {
    btn.disabled = false;
    if (err instanceof ApiError) {
      const details = (err.details || []).map((d) => d.message).join("; ");
      showMsg(details || err.message, "err");
    } else if (err instanceof NetworkError) {
      showMsg("Сервер недоступен. Проверьте интернет и попробуйте ещё раз.", "err");
    } else {
      showMsg("Не получилось: " + err.message, "err");
    }
  } finally {
    clearTimeout(hint);
  }
}

function renderProfile(user) {
  els.accountView.innerHTML = `
    <div class="detail-top"><button class="back-btn" id="accBack">← К списку</button></div>
    <div class="panel auth-panel">
      <h1 class="detail-title">👤 ${esc(user.displayName)}</h1>
      <p class="auth-hint">${esc(user.email)}${user.role === "ADMIN" ? ' · <span class="mini-tag">администратор</span>' : ""}</p>
      <p class="sync-line" id="syncLine">${esc(syncText())}</p>
      <div class="detail-actions">
        <button class="act-btn" id="syncNow">🔄 Синхронизировать</button>
        ${isAdmin() ? `<button class="act-btn" id="toAdmin">🛠 Админка</button>` : ""}
        <button class="act-btn" id="logoutBtn">🚪 Выйти</button>
      </div>
      <p class="auth-hint small">Избранное, заметки и список покупок хранятся в аккаунте. Отметки в рецептах,
        «недавно смотрели» и тема остаются только на этом устройстве.</p>
    </div>`;

  document.getElementById("accBack").addEventListener("click", () => { location.hash = "#"; });
  document.getElementById("syncNow").addEventListener("click", () => sync.flush().catch(() => {}));
  const adm = document.getElementById("toAdmin");
  if (adm) adm.addEventListener("click", () => { location.hash = "#/admin"; });
  document.getElementById("logoutBtn").addEventListener("click", async (e) => {
    e.target.disabled = true;
    const ok = await sync.logout(async (n) =>
      confirm(`${n} ${plural(n, "изменение не сохранено", "изменения не сохранены", "изменений не сохранены")} в аккаунте, выйти всё равно?`));
    if (ok) { mode = "login"; toast("Вы вышли из аккаунта"); }
    else e.target.disabled = false;
  });
}

// Обновить только строку статуса (без перерисовки формы)
export function updateSyncLine() {
  const line = document.getElementById("syncLine");
  if (line) line.textContent = syncText();
}
