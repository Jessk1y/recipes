// Flux-хранилище: единственное место, где меняется состояние приложения.
// Представления читают состояние через геттеры и меняют его только через dispatch(action).
// Цепочка: действие → редьюсер → сохранение в localStorage → middleware (outbox) → подписчики (перерисовка).
import { LS } from "./storage.js";
import { SYNC_OPS, applyOp, emptyData, migrateShopping } from "./ops.js";
import { parseIng } from "../lib/utils.js";

function loadData() {
  return {
    favs: LS.get("favs", []),
    notes: LS.get("notes", {}),
    shopping: migrateShopping(LS.get("shopping", []), parseIng),
  };
}
function saveData(d) {
  LS.set("favs", d.favs);
  LS.set("notes", d.notes);
  LS.set("shopping", d.shopping);
}

const s = {
  data: loadData(),                      // синхронизируемые: избранное, заметки, список покупок
  checks: LS.get("checks", {}),          // только на устройстве: отметки ингредиентов/шагов
  recent: LS.get("recent", []),          // только на устройстве: недавно смотрели
  catalog: { recipes: [], version: null, source: null }, // source: cache | fallback | server
  user: (LS.get("auth", null) || {}).user || null,       // вошедший пользователь или null (гость)
  sync: { status: "idle", pending: (LS.get("outbox", []) || []).length, lastAt: LS.get("syncAt", null) },
};

// ---------- Чтение ----------
export const getData = () => s.data;
export const isFav = (id) => s.data.favs.includes(id);
export const getChecks = () => s.checks;
export const getRecent = () => s.recent;
export const getCatalog = () => s.catalog;
export const getUser = () => s.user;
export const isAdmin = () => !!s.user && s.user.role === "ADMIN";
export const getSync = () => s.sync;

// ---------- Подписки и middleware ----------
const listeners = new Set();
const middleware = [];
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function use(fn) { middleware.push(fn); }

// ---------- Редьюсер ----------
function reduce(action) {
  if (SYNC_OPS.has(action.type)) {
    s.data = applyOp(s.data, action);
    saveData(s.data);
    return;
  }
  switch (action.type) {
    case "data.replace":   // состояние с сервера (+ неотправленные операции поверх)
      s.data = action.data;
      saveData(s.data);
      break;
    case "data.clear":     // выход из аккаунта
      s.data = emptyData();
      saveData(s.data);
      break;
    case "data.external":  // другая вкладка изменила localStorage
      s.data = loadData();
      s.checks = LS.get("checks", {});
      s.recent = LS.get("recent", []);
      break;
    case "checks.toggle": {
      const c = (s.checks[action.id] = s.checks[action.id] || { ing: {}, step: {} });
      c[action.kind] = c[action.kind] || {};
      if (action.on) c[action.kind][action.idx] = 1; else delete c[action.kind][action.idx];
      LS.set("checks", s.checks);
      break;
    }
    case "checks.reset":
      delete s.checks[action.id];
      LS.set("checks", s.checks);
      break;
    case "recent.push":
      s.recent = [action.id, ...s.recent.filter((x) => x !== action.id)].slice(0, 8);
      LS.set("recent", s.recent);
      break;
    case "catalog.set":
      s.catalog = { recipes: action.recipes, version: action.version, source: action.source };
      break;
    case "session.set":
      s.user = action.user;
      break;
    case "sync.status":
      s.sync = { ...s.sync, ...action.patch };
      if (action.patch.lastAt) LS.set("syncAt", action.patch.lastAt);
      break;
  }
}

export function dispatch(action) {
  reduce(action);
  middleware.forEach((fn) => fn(action));
  listeners.forEach((fn) => fn(action));
}

// Изменения из других вкладок того же сайта
window.addEventListener("storage", (e) => {
  if (!e.key || !e.key.startsWith("recipes:")) return;
  const key = e.key.slice(8);
  if (["favs", "notes", "shopping", "checks", "recent"].includes(key)) dispatch({ type: "data.external" });
  if (key === "auth") {
    const user = (LS.get("auth", null) || {}).user || null;
    if ((user && user.id) !== (s.user && s.user.id)) dispatch({ type: "session.set", user, external: true });
  }
  if (key === "outbox") dispatch({ type: "sync.status", patch: { pending: LS.get("outbox", []).length } });
});
