// Учёт «этот рецепт на этом устройстве уже засчитан» — чистые функции (без DOM и localStorage), см. sync/views.js.
// Лог хранит только slug рецепта и время отправки; личных данных нет.
export const VIEW_TTL = 24 * 60 * 60 * 1000;

// Пора ли слать просмотр: раньше не слали, прошли сутки или часы устройства переведены назад
export function dueForView(log, id, now) {
  const t = log && log[id];
  return !(Number.isFinite(t) && t <= now && now - t < VIEW_TTL);
}

// Новый лог с отметкой «id засчитан сейчас»; записи старше суток выбрасываются, чтобы лог не рос
export function markViewed(log, id, now) {
  const next = {};
  for (const [k, t] of Object.entries(log || {})) {
    if (Number.isFinite(t) && t <= now && now - t < VIEW_TTL) next[k] = t;
  }
  next[id] = now;
  return next;
}
