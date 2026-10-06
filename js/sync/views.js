// Счётчик просмотров рецептов: при открытии рецепта — один лёгкий POST /stats/view, не чаще раза в сутки
// с устройства (лог «рецепт → время» в localStorage). Сервер хранит только число просмотров за день.
// Не мешает работе: офлайн и ошибки молча пропускаются (повторится при следующем открытии),
// просмотры администратора не считаются.
import { LS } from "../core/storage.js";
import { isAdmin } from "../core/store.js";
import * as endpoints from "../api/endpoints.js";
import { dueForView, markViewed } from "../lib/viewLog.js";

const inflight = new Set();

export function trackView(id) {
  if (!id || isAdmin() || inflight.has(id) || navigator.onLine === false) return;
  if (!dueForView(LS.get("viewed", {}), id, Date.now())) return;
  inflight.add(id);
  endpoints.trackView(id)
    .then(() => LS.set("viewed", markViewed(LS.get("viewed", {}), id, Date.now())))
    .catch(() => {})
    .finally(() => inflight.delete(id));
}
