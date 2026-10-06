// Синхронизация личных данных с аккаунтом через outbox.
//  - Гость: всё только в localStorage, сеть не нужна.
//  - Вошедший: каждое действие сразу меняет локальное состояние (оптимистично) и кладётся в outbox
//    (recipes:outbox) со временем действия at. Outbox отправляется в POST /me/sync пачками ≤200;
//    ответ — полное состояние аккаунта, поверх которого заново применяются ещё не отправленные операции.
//  - Нет сети / сервер спит — outbox копится и уходит при появлении связи.
import { LS, withLock } from "../core/storage.js";
import { dispatch, use, getData, getUser, getCatalog } from "../core/store.js";
import { SYNC_OPS, fromServer, replay } from "../core/ops.js";
import * as endpoints from "../api/endpoints.js";
import { ApiError, NetworkError, SessionExpired, getAuth, saveAuth, clearAuth, setAccessToken, setSessionLostHandler } from "../api/client.js";
import { toast } from "../lib/utils.js";
import { dropPushOnLogout } from "./push.js";

const BATCH = 200;
const FLUSH_DELAY = 1500;
const RETRY_DELAY = 30000;
const PULL_EVERY = 30000; // не чаще — подтягивать изменения с других устройств при возврате на вкладку

const readOutbox = () => LS.get("outbox", []) || [];
function writeOutbox(list) {
  LS.set("outbox", list);
  dispatch({ type: "sync.status", patch: { pending: list.length } });
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const strip = ({ id, ...op }) => op;

function enqueue(ops) {
  let list = readOutbox();
  for (const op of ops) {
    // правки одной заметки схлопываются: на сервер уходит только последняя
    if (op.type.startsWith("note.")) list = list.filter((o) => !(o.type.startsWith("note.") && o.slug === op.slug));
    list.push({ ...op, id: newId(), at: op.at || new Date().toISOString() });
  }
  writeOutbox(list);
  scheduleFlush(FLUSH_DELAY);
}

// middleware хранилища: пользовательские действия вошедшего — в outbox
use((action) => {
  if (SYNC_OPS.has(action.type) && getUser()) {
    const { type, slug, text, name, amount, recipe, checked } = action;
    const op = { type };
    if (slug !== undefined) op.slug = slug;
    if (text !== undefined) op.text = text;
    if (name !== undefined) op.name = name;
    if (amount) op.amount = amount;
    if (recipe) op.recipe = recipe;
    if (checked !== undefined) op.checked = checked;
    enqueue([op]);
  }
});

let flushTimer = null;
function scheduleFlush(ms) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush().catch(() => {}), ms);
}

// Отправить outbox (или просто подтянуть состояние, если он пуст).
let running = null, again = false;
export function flush() {
  if (!getUser()) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    dispatch({ type: "sync.status", patch: { status: "syncing" } });
    try {
      do {
        again = false;
        await withLock("recipes-sync", flushOnce);
      } while (again || readOutbox().length);
      clearTimeout(flushTimer); // всё отправлено — отложенный повтор не нужен
      dispatch({ type: "sync.status", patch: { status: "ok", lastAt: new Date().toISOString(), error: null } });
    } catch (e) {
      if (e instanceof SessionExpired) {
        dispatch({ type: "sync.status", patch: { status: "idle" } });
      } else {
        const offline = e instanceof NetworkError;
        dispatch({ type: "sync.status", patch: { status: offline ? "offline" : "error", error: e.message } });
        scheduleFlush(RETRY_DELAY);
      }
      throw e;
    }
  })().finally(() => { running = null; });
  return running;
}

async function flushOnce() {
  if (LS.get("mergePending", false)) await mergeGuestData();
  const batch = readOutbox().slice(0, BATCH);
  let res;
  try {
    res = await endpoints.sync(batch.map(strip));
  } catch (e) {
    // сервер отклонил пачку целиком (не должно случаться — значения обрезаются заранее):
    // выбрасываем её, чтобы outbox не застрял навсегда
    if (e instanceof ApiError && e.status === 422) {
      console.warn("sync: пачка отклонена", e.details);
      dropSent(batch);
      toast("Часть изменений не удалось сохранить в аккаунте");
      return;
    }
    throw e;
  }
  const rest = dropSent(batch);
  if (res.skipped.length) console.info("sync: пропущены операции", res.skipped);
  dispatch({ type: "data.replace", data: replay(fromServer(res), rest) });
}

function dropSent(batch) {
  const ids = new Set(batch.map((o) => o.id));
  const rest = readOutbox().filter((o) => !ids.has(o.id)); // перечитываем: могли добавиться новые
  writeOutbox(rest);
  return rest;
}

// ---------- Перенос гостевых данных в аккаунт (первый вход на устройстве) ----------
// Избранное и список покупок объединяются; заметка, которой нет в аккаунте, переносится,
// а если в аккаунте другая — тексты склеиваются (ничего не теряется).
async function mergeGuestData() {
  const local = getData();
  const res = await endpoints.sync([]);
  const server = fromServer(res);
  // время операций — не раньше серверного «сейчас», иначе склеенная заметка проиграет LWW
  const at = new Date(Math.max(Date.now(), Date.parse(res.serverTime) + 1)).toISOString();
  const ops = [];
  local.favs.forEach((slug) => { if (!server.favs.includes(slug)) ops.push({ type: "favorite.add", slug, at }); });
  Object.entries(local.notes).forEach(([slug, text]) => {
    const theirs = server.notes[slug];
    if (!text.trim() || theirs === text) return;
    const merged = !theirs ? text
      : theirs.includes(text.trim()) ? null
      : theirs + "\n\n— с этого устройства —\n" + text;
    if (merged) ops.push({ type: "note.set", slug, text: merged.slice(0, 2000), at });
  });
  // продукт блюда, которого нет в каталоге (удалено), переносим как добавленный вручную — иначе сервер его отбросит
  const known = new Set(getCatalog().recipes.map((r) => r.id));
  local.shopping.forEach((it) => {
    const contribs = it.contribs && it.contribs.length ? it.contribs : [{ r: null, a: "" }];
    contribs.forEach((c) => {
      const op = { type: "shopping.add", name: it.name.slice(0, 120), at };
      if (c.a) op.amount = String(c.a).slice(0, 200);
      if (c.r && known.has(c.r)) op.recipe = c.r;
      ops.push(op);
    });
    if (it.checked) ops.push({ type: "shopping.check", name: it.name.slice(0, 120), checked: true, at });
  });
  LS.remove("mergePending");
  if (ops.length) enqueue(ops);
  dispatch({ type: "data.replace", data: replay(server, readOutbox()) });
}

// ---------- Сессия ----------
async function startSession(r) {
  setAccessToken(r.accessToken);
  saveAuth({ refreshToken: r.refreshToken, user: r.user });
  LS.set("mergePending", true);
  dispatch({ type: "session.set", user: r.user });
  try { await flush(); } catch (e) {} // не вышло — перенос доделается при следующей синхронизации
}

export async function login(email, password) {
  await startSession(await endpoints.login(email, password));
}
// Возвращает { verificationSent }: ушло ли письмо с подтверждением e-mail
export async function register(email, password, confirmPassword, displayName, turnstileToken) {
  const r = await endpoints.register(email, password, confirmPassword, displayName, turnstileToken);
  await startSession(r);
  return { verificationSent: r.verificationSent !== false };
}

// Выход: сначала отправляем outbox; если что-то не ушло — спрашиваем. Личные данные стираются с устройства.
export async function logout(confirmLoss) {
  try { await flush(); } catch (e) {}
  const pending = readOutbox().length;
  if (pending && !(await confirmLoss(pending))) return false;
  await dropPushOnLogout(); // пока токен ещё действует
  const auth = getAuth();
  if (auth) { try { await endpoints.logout(auth.refreshToken); } catch (e) {} }
  clearAuth();
  LS.remove("outbox");
  LS.remove("mergePending");
  LS.remove("syncAt");
  dispatch({ type: "data.clear" });
  dispatch({ type: "sync.status", patch: { pending: 0, status: "idle", lastAt: null, error: null } });
  dispatch({ type: "session.set", user: null });
  return true;
}

// Refresh-токен отозван/истёк/аккаунт заблокирован: выходим, но данные и outbox НЕ стираем —
// после повторного входа они перенесутся в аккаунт.
setSessionLostHandler((e) => {
  dispatch({ type: "session.set", user: null });
  dispatch({ type: "sync.status", patch: { status: "idle" } });
  toast(e.code === "ACCOUNT_BLOCKED" ? "Аккаунт заблокирован" : "Сессия истекла — войдите снова");
});

// Обновить профиль (роль могла поменяться) — при старте приложения
export async function refreshProfile() {
  if (!getUser()) return;
  try {
    const user = await endpoints.me();
    const auth = getAuth();
    if (auth) saveAuth({ ...auth, user });
    dispatch({ type: "session.set", user });
  } catch (e) {}
}

let lastPull = 0;
export function startSync() {
  window.addEventListener("online", () => flush().catch(() => {}));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastPull > PULL_EVERY) {
      lastPull = Date.now();
      flush().catch(() => {});
    }
  });
  lastPull = Date.now();
  if (getUser()) flush().catch(() => {});
}

