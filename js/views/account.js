// Аккаунт (#/account): вход, регистрация и «забыли пароль» для гостя, профиль и состояние синхронизации
// для вошедшего. Здесь же страницы по ссылкам из писем: #/verify?token=… и #/reset?token=…
import { WAKE_HINT_AFTER } from "../config.js";
import { els } from "./ui.js";
import { getUser, getSync, isAdmin } from "../core/store.js";
import { mailEnabled, turnstileKey } from "../core/serverConfig.js";
import { mountTurnstile } from "../lib/turnstile.js";
import * as sync from "../sync/sync.js";
import * as endpoints from "../api/endpoints.js";
import { ApiError, NetworkError } from "../api/client.js";
import { esc, plural, toast } from "../lib/utils.js";
import { suggestEmail, isAsciiEmail } from "../lib/emailTypos.js";

let mode = "login"; // login | register | forgot
let captcha = null; // виджет Turnstile формы регистрации (если капча включена на сервере)
let flash = "";     // одноразовое сообщение над формой (например, «пароль изменён»)

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
  if (mode === "forgot" && !mailEnabled()) mode = "login"; // почта отключена — сброса по письму нет
  if (mode === "forgot") return renderForgot();

  const reg = mode === "register";
  els.accountView.innerHTML = `
    <div class="detail-top"><button class="back-btn" id="accBack">← К списку</button></div>
    <div class="panel auth-panel">
      <div class="auth-tabs">
        <button class="tag-chip${!reg ? " active" : ""}" data-mode="login">Вход</button>
        <button class="tag-chip${reg ? " active" : ""}" data-mode="register">Регистрация</button>
      </div>
      <p class="auth-hint">Войдите, чтобы избранное, заметки и список покупок были на всех ваших устройствах.
        То, что уже сохранено на этом устройстве, перенесётся в аккаунт.</p>
      ${flash ? `<div class="form-msg info" style="margin-bottom:14px">${esc(flash)}</div>` : ""}
      <form id="authForm" class="form" novalidate>
        ${reg ? `<label class="field">Имя<input name="displayName" class="ct-input" autocomplete="nickname" maxlength="50" required></label>` : ""}
        <label class="field">E-mail<input name="email" type="email" class="ct-input" autocomplete="email" required></label>
        ${reg ? `<div id="emailHint" class="form-msg info" hidden></div>` : ""}
        <label class="field">Пароль${reg ? ' <span class="hint">(не меньше 8 символов)</span>' : ""}
          <input name="password" type="password" class="ct-input" minlength="${reg ? 8 : 1}" maxlength="72"
            autocomplete="${reg ? "new-password" : "current-password"}" required></label>
        ${reg ? `<label class="field">Повторите пароль
          <input name="confirmPassword" type="password" class="ct-input" maxlength="72" autocomplete="new-password" required></label>` : ""}
        ${reg && turnstileKey() ? `<div id="captchaBox" class="captcha-box"></div>` : ""}
        <div id="authMsg" class="form-msg" hidden></div>
        <button class="tool-btn accent" id="authSubmit" type="submit">${reg ? "Зарегистрироваться" : "Войти"}</button>
        ${!reg && mailEnabled() ? `<button class="link-btn" type="button" id="toForgot">Забыли пароль?</button>` : ""}
      </form>
    </div>`;
  flash = "";

  document.getElementById("accBack").addEventListener("click", () => { location.hash = "#"; });
  els.accountView.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => { mode = b.dataset.mode; renderAccount(); }));
  const forgot = document.getElementById("toForgot");
  if (forgot) forgot.addEventListener("click", () => { mode = "forgot"; renderAccount(); });
  document.getElementById("authForm").addEventListener("submit", onSubmit);
  if (reg) setupEmailHint(document.getElementById("authForm").email);
  if (captcha) { captcha.remove(); captcha = null; }
  const box = document.getElementById("captchaBox");
  if (box) {
    captcha = mountTurnstile(box, turnstileKey());
    captcha.ready.catch((err) => showMsg(err.message, "err"));
  }
}

// Регистрация: после ввода адреса предлагаем исправить очевидную опечатку в домене («gmial.com → gmail.com?»)
function setupEmailHint(input) {
  const hint = document.getElementById("emailHint");
  const update = () => {
    const fixed = suggestEmail(input.value.trim());
    hint.hidden = !fixed;
    if (!fixed) return;
    hint.textContent = "Возможно, вы имели в виду ";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link-btn";
    b.textContent = fixed;
    b.addEventListener("click", () => { input.value = fixed; hint.hidden = true; input.focus(); });
    hint.append(b, "?");
  };
  input.addEventListener("blur", update);
  input.addEventListener("input", () => { hint.hidden = true; });
}

// «Забыли пароль?»: ответ сервера всегда одинаков, поэтому и текст одинаков
function renderForgot() {
  els.accountView.innerHTML = `
    <div class="detail-top"><button class="back-btn" id="accBack">← К входу</button></div>
    <div class="panel auth-panel">
      <h1 class="detail-title">Сброс пароля</h1>
      <p class="auth-hint">Укажите e-mail аккаунта — мы отправим ссылку для создания нового пароля (действует 1 час).</p>
      <form id="forgotForm" class="form" novalidate>
        <label class="field">E-mail<input name="email" type="email" class="ct-input" autocomplete="email" required></label>
        <div id="authMsg" class="form-msg" hidden></div>
        <button class="tool-btn accent" id="authSubmit" type="submit">Отправить ссылку</button>
      </form>
    </div>`;
  document.getElementById("accBack").addEventListener("click", () => { mode = "login"; renderAccount(); });
  document.getElementById("forgotForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = e.target.email.value.trim();
    if (!email) return showMsg("Укажите e-mail", "err");
    const btn = document.getElementById("authSubmit");
    btn.disabled = true;
    showMsg("");
    const hint = setTimeout(() => showMsg("Сервер просыпается — это может занять до минуты…", "info"), WAKE_HINT_AFTER);
    try {
      await endpoints.forgotPassword(email);
      showMsg("Если такой e-mail зарегистрирован, мы отправили на него письмо со ссылкой. Проверьте также папку «Спам».", "info");
      setTimeout(() => { btn.disabled = false; }, 30_000); // не даём жать подряд (сервер всё равно ограничит)
    } catch (err) {
      btn.disabled = false;
      showMsg(errText(err), "err");
    } finally {
      clearTimeout(hint);
    }
  });
}

function showMsg(text, kind) {
  const m = document.getElementById("authMsg");
  if (!m) return;
  m.hidden = !text;
  m.textContent = text || "";
  m.className = "form-msg" + (kind ? " " + kind : "");
}

function errText(err) {
  if (err instanceof ApiError) {
    const details = Array.isArray(err.details) ? err.details.map((d) => d.message).join("; ") : "";
    return details || err.message;
  }
  if (err instanceof NetworkError) return "Сервер недоступен. Проверьте интернет и попробуйте ещё раз.";
  return "Не получилось: " + err.message;
}

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const email = f.email.value.trim();
  const password = f.password.value;
  const name = f.displayName ? f.displayName.value.trim() : "";
  const confirm = f.confirmPassword ? f.confirmPassword.value : "";
  if (!email || !password || (mode === "register" && (!name || !confirm))) return showMsg("Заполните все поля", "err");
  if (mode === "register" && !isAsciiEmail(email)) return showMsg("E-mail — только латинские буквы, цифры и обычные символы (без кириллицы и пробелов)", "err");
  if (mode === "register" && password.length < 8) return showMsg("Пароль — не меньше 8 символов", "err");
  if (mode === "register" && password !== confirm) return showMsg("Пароли не совпадают", "err");
  if (mode === "register" && captcha && !captcha.token()) return showMsg("Подтвердите, что вы не робот", "err");

  const btn = document.getElementById("authSubmit");
  btn.disabled = true;
  showMsg("");
  const hint = setTimeout(() => showMsg("Сервер просыпается — это может занять до минуты…", "info"), WAKE_HINT_AFTER);
  try {
    if (mode === "register") {
      const { verificationSent } = await sync.register(email, password, confirm, name, captcha ? captcha.token() : "");
      toast(verificationSent ? "Вы вошли ✅ Проверьте почту — отправили письмо для подтверждения" : "Вы вошли ✅");
    } else {
      await sync.login(email, password);
      toast("Вы вошли ✅");
    }
    // экран перерисуется по событию session.set
  } catch (err) {
    btn.disabled = false;
    showMsg(errText(err), "err");
    if (captcha) captcha.reset(); // токен одноразовый — после любой неудачи нужен новый
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
      ${user.emailVerified === false && mailEnabled() ? `
        <div class="form-msg info verify-note">
          ✉️ E-mail не подтверждён. Мы отправили письмо со ссылкой — перейдите по ней (действует 24 часа).
          Неподтверждённый аккаунт удаляется через 7 дней после регистрации.
          <div class="verify-actions"><button class="act-btn" id="resendVerify">Отправить письмо ещё раз</button></div>
          <div id="verifyMsg" class="verify-msg" hidden></div>
        </div>` : ""}
      <p class="sync-line" id="syncLine">${esc(syncText())}</p>
      <div class="detail-actions">
        <button class="act-btn" id="syncNow">🔄 Синхронизировать</button>
        <button class="act-btn" id="toMy">📨 Мои предложения</button>
        ${isAdmin() ? `<button class="act-btn" id="toAdmin">🛠 Админка</button>` : ""}
        <button class="act-btn" id="logoutBtn">🚪 Выйти</button>
      </div>
      <p class="auth-hint small">Избранное, заметки и список покупок хранятся в аккаунте. Отметки в рецептах,
        «недавно смотрели» и тема остаются только на этом устройстве.</p>
    </div>`;

  document.getElementById("accBack").addEventListener("click", () => { location.hash = "#"; });
  const resend = document.getElementById("resendVerify");
  if (resend) resend.addEventListener("click", async () => {
    const msg = document.getElementById("verifyMsg");
    const say = (t) => { msg.hidden = false; msg.textContent = t; };
    resend.disabled = true;
    try {
      await endpoints.resendVerification();
      say("Письмо отправлено. Проверьте почту (и папку «Спам»).");
      setTimeout(() => { resend.disabled = false; }, 60_000);
    } catch (err) {
      say(errText(err));
      resend.disabled = false;
    }
  });
  document.getElementById("syncNow").addEventListener("click", () => sync.flush().catch(() => {}));
  document.getElementById("toMy").addEventListener("click", () => { location.hash = "#/my"; });
  const adm = document.getElementById("toAdmin");
  if (adm) adm.addEventListener("click", () => { location.hash = "#/admin"; });
  document.getElementById("logoutBtn").addEventListener("click", async (e) => {
    e.target.disabled = true;
    mode = "login"; // экран входа перерисуется по session.set ещё до возврата из logout
    const ok = await sync.logout(async (n) =>
      confirm(`${n} ${plural(n, "изменение не сохранено", "изменения не сохранены", "изменений не сохранены")} в аккаунте, выйти всё равно?`));
    if (ok) toast("Вы вышли из аккаунта");
    else e.target.disabled = false;
  });
}

// Обновить только строку статуса (без перерисовки формы)
export function updateSyncLine() {
  const line = document.getElementById("syncLine");
  if (line) line.textContent = syncText();
}

// ---------- Страницы по ссылкам из писем ----------
const tokenOf = (hash) => new URLSearchParams(hash.split("?")[1] || "").get("token") || "";
const NO_TOKEN = "В ссылке нет токена. Откройте письмо и перейдите по ссылке ещё раз.";

// Токен читает страница и отправляет в API (POST): предпросмотр ссылки в почтовике ничего не расходует
export async function renderVerify(hash) {
  const token = tokenOf(hash);
  els.accountView.innerHTML = `
    <div class="detail-top"><button class="back-btn" id="accBack">← К списку</button></div>
    <div class="panel auth-panel"><h1 class="detail-title">Подтверждение e-mail</h1>
      <p class="auth-hint" id="verifyStatus">Проверяем ссылку…</p></div>`;
  document.getElementById("accBack").addEventListener("click", () => { location.hash = "#"; });
  const status = document.getElementById("verifyStatus");
  if (!token) { status.textContent = NO_TOKEN; return; }
  try {
    const r = await endpoints.verifyEmail(token);
    status.textContent = `✅ E-mail ${r.email} подтверждён. Спасибо!`;
    sync.refreshProfile(); // если вы уже вошли на этом устройстве — убрать плашку «не подтверждён»
  } catch (err) {
    status.textContent = err instanceof ApiError && err.code === "INVALID_TOKEN"
      ? "Ссылка недействительна, устарела или уже использована. Войдите в аккаунт и запросите новое письмо в профиле."
      : errText(err);
  }
}

export function renderReset(hash) {
  const token = tokenOf(hash);
  els.accountView.innerHTML = `
    <div class="detail-top"><button class="back-btn" id="accBack">← К списку</button></div>
    <div class="panel auth-panel">
      <h1 class="detail-title">Новый пароль</h1>
      ${token ? `<p class="auth-hint">Придумайте новый пароль. После смены вы выйдете из аккаунта на всех устройствах.</p>
      <form id="resetForm" class="form" novalidate>
        <label class="field">Новый пароль <span class="hint">(не меньше 8 символов)</span>
          <input name="password" type="password" class="ct-input" minlength="8" maxlength="72" autocomplete="new-password" required></label>
        <label class="field">Повторите пароль
          <input name="confirmPassword" type="password" class="ct-input" maxlength="72" autocomplete="new-password" required></label>
        <div id="authMsg" class="form-msg" hidden></div>
        <button class="tool-btn accent" id="authSubmit" type="submit">Сохранить пароль</button>
      </form>` : `<p class="auth-hint">${NO_TOKEN}</p>`}
    </div>`;
  document.getElementById("accBack").addEventListener("click", () => { location.hash = "#"; });
  const form = document.getElementById("resetForm");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { password, confirmPassword } = e.target;
    if (password.value.length < 8) return showMsg("Пароль — не меньше 8 символов", "err");
    if (password.value !== confirmPassword.value) return showMsg("Пароли не совпадают", "err");
    const btn = document.getElementById("authSubmit");
    btn.disabled = true;
    showMsg("");
    const hint = setTimeout(() => showMsg("Сервер просыпается — это может занять до минуты…", "info"), WAKE_HINT_AFTER);
    try {
      await endpoints.resetPassword(token, password.value, confirmPassword.value);
      mode = "login";
      flash = "Пароль изменён. Войдите с новым паролем.";
      location.hash = "#/account";
    } catch (err) {
      btn.disabled = false;
      showMsg(err instanceof ApiError && err.code === "INVALID_TOKEN"
        ? "Ссылка недействительна, устарела или уже использована. Запросите новую на экране входа («Забыли пароль?»)."
        : errText(err), "err");
    } finally {
      clearTimeout(hint);
    }
  });
}
