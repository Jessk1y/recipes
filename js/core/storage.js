// ---------- Хранилище (localStorage) ----------
// Все ключи с префиксом "recipes:".
export const LS = {
  get(key, def) {
    try { const v = localStorage.getItem("recipes:" + key); return v ? JSON.parse(v) : def; }
    catch (e) { return def; }
  },
  set(key, val) {
    try { localStorage.setItem("recipes:" + key, JSON.stringify(val)); } catch (e) {}
  },
  remove(key) {
    try { localStorage.removeItem("recipes:" + key); } catch (e) {}
  },
};

// Межвкладочная блокировка (Web Locks API); в старых браузерах — просто выполняем.
export function withLock(name, fn) {
  if (navigator.locks && navigator.locks.request) return navigator.locks.request(name, fn);
  return fn();
}
