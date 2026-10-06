// HTTP-клиент API. Access-токен живёт только в памяти, refresh-токен — в localStorage (recipes:auth),
// как в архитектуре (ПР №3): cookie между github.io и onrender.com браузеры блокируют.
import { API_BASE, SLOW_TIMEOUT } from "../config.js";
import { LS, withLock } from "../core/storage.js";

// Ответ сервера с ошибкой ({ error: { code, message, details } })
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}
// Сеть недоступна, таймаут или сервер ещё просыпается — можно повторить позже
export class NetworkError extends Error {}
// Refresh-токен недействителен — нужно войти заново
export class SessionExpired extends Error {}

let accessToken = null;
let onSessionLost = () => {};
export const setAccessToken = (t) => { accessToken = t; };
export const setSessionLostHandler = (fn) => { onSessionLost = fn; };
export const getAuth = () => LS.get("auth", null);
export const saveAuth = (auth) => LS.set("auth", auth);
export function clearAuth() { accessToken = null; LS.remove("auth"); }

export async function raw(path, { method = "GET", body, form, token, timeout = 15000, cache } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(API_BASE + "/api/v1" + path, {
      method, headers, signal: ctrl.signal, cache,
      body: form || (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (e) {
    throw new NetworkError(ctrl.signal.aborted ? "Сервер не ответил вовремя" : "Нет связи с сервером");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return null;
  let json = null;
  try { json = await res.json(); } catch (e) {}
  // 502–504 без JSON-ошибки API отдаёт прокси Render, пока сервер просыпается;
  // 503 MAIL_DISABLED («почта отключена») — ответ самого API, его показываем как есть
  if ([502, 503, 504].includes(res.status) && !(json && json.error && json.error.code)) {
    throw new NetworkError("Сервер временно недоступен");
  }
  if (!res.ok) {
    const err = (json && json.error) || {};
    throw new ApiError(res.status, err.code || "HTTP_" + res.status, err.message || "Ошибка сервера", err.details);
  }
  return json;
}

// Обновление access-токена. Под блокировкой: две вкладки, одновременно предъявившие один
// refresh-токен, сервер расценит как кражу (TOKEN_REUSED) и завершит сессию. Внутри блокировки
// токен перечитывается из localStorage — его могла уже обновить другая вкладка.
let refreshing = null;
export function refreshAccess() {
  if (!refreshing) {
    refreshing = Promise.resolve(withLock("recipes-auth", async () => {
      const auth = getAuth();
      if (!auth) throw new SessionExpired("Не выполнен вход");
      try {
        const r = await raw("/auth/refresh", { method: "POST", body: { refreshToken: auth.refreshToken }, timeout: SLOW_TIMEOUT });
        accessToken = r.accessToken;
        saveAuth({ ...auth, refreshToken: r.refreshToken });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          clearAuth();
          onSessionLost(e);
          throw new SessionExpired(e.message);
        }
        throw e;
      }
    })).finally(() => { refreshing = null; });
  }
  return refreshing;
}

// Запрос к API; auth: true — с токеном (обновляется автоматически, один повтор при 401)
export async function api(path, opts = {}) {
  if (!opts.auth) return raw(path, opts);
  if (!accessToken) await refreshAccess();
  try {
    return await raw(path, { ...opts, token: accessToken });
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    await refreshAccess();
    return raw(path, { ...opts, token: accessToken });
  }
}

// Абсолютный адрес картинки (фото, загруженные в локальное хранилище сервера, — путь /uploads/…)
export const imageUrl = (u) => (u && u.startsWith("/uploads/") ? API_BASE + u : u);
