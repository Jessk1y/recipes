// Автосохранение несохранённой формы рецепта в localStorage (любой режим) — чистая логика без DOM,
// хранилище передаётся снаружи (LS из core/storage.js), поэтому проверяется тестами в node.
import { LS } from "../core/storage.js";

// хранилище для формы: recipeForm.js не импортирует core/storage напрямую (защита предпросмотра от побочных эффектов)
export const draftStore = LS;

export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // черновик старше месяца не предлагаем

const MODE_KEY = { user: "my", moderate: "review", admin: "admin" };

// Ключ — по пользователю, режиму и рецепту: правка «Борща» не путается с новым рецептом или чужим аккаунтом
export const draftKey = ({ uid, mode, id }) => `draft:${uid || "anon"}:${MODE_KEY[mode] || mode}:${id || "new"}`;

// Содержимое формы (collect()) как строка для сравнения: то же, что на сервере/в исходном рецепте — черновика нет
export const contentKey = (input) => JSON.stringify(input);

// Сохранить, если форма отличается от исходной; вернулась к исходной — черновик не нужен. Возвращает true, если сохранили.
export function syncDraft(store, key, input, baseline, base, now = Date.now()) {
  if (contentKey(input) === baseline) { store.remove(key); return false; }
  store.set(key, { input, base: base || null, savedAt: now });
  return true;
}

// Черновик или null: битый, просроченный и совпадающий с исходным рецептом удаляются
export function loadDraft(store, key, baseline, now = Date.now()) {
  const d = store.get(key, null);
  const ok = d && typeof d === "object" && d.input && typeof d.input === "object" && Number.isFinite(d.savedAt)
    && now - d.savedAt < DRAFT_TTL_MS && contentKey(d.input) !== baseline;
  if (!ok) { if (d) store.remove(key); return null; }
  return d;
}

export const clearDraft = (store, key) => store.remove(key);

// Рецепт для формы из черновика: поля формы — из черновика, служебные (id, статус автора и т. п.) — из исходного
export function draftRecipe(base, input) {
  const empty = { title: "", slug: "", category: { name: "" }, main: [], tags: [], image: null, time: "", servings: "", ingredients: [], steps: [], status: "DRAFT" };
  const r = { ...empty, ...(base || {}) };
  return {
    ...r,
    title: input.title ?? "",
    slug: input.slug ?? r.slug ?? "",
    category: { name: input.category ?? "" },
    main: input.main || [],
    tags: input.tags || [],
    image: input.image || null,
    time: input.time || "",
    servings: input.servings || "",
    ingredients: input.ingredients || [],
    steps: input.steps || [],
    status: input.status || r.status,
  };
}
