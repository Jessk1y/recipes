// Создатели действий: всё, что меняет личные данные, проходит здесь.
// Значения обрезаются под ограничения API заранее, чтобы операция в outbox не была отклонена сервером.
import { dispatch, isFav, getData, getChecks } from "./store.js";
import { parseIng, normName, scaleQty } from "../lib/utils.js";

const cut = (s, n) => String(s || "").trim().slice(0, n);

export function toggleFav(id) {
  dispatch({ type: isFav(id) ? "favorite.remove" : "favorite.add", slug: id });
}

export function setNote(id, text) {
  dispatch({ type: "note.set", slug: id, text: String(text).slice(0, 2000) });
}

// Добавить ингредиенты рецепта (кроме вычеркнутых). Возвращает число новых вкладов.
export function addRecipeToShopping(r, factor) {
  const checks = (getChecks()[r.id] && getChecks()[r.id].ing) || {};
  let added = 0;
  (r.ingredients || []).forEach((ing, idx) => {
    if (ing && typeof ing === "object") return;      // под-заголовок
    if (checks[idx]) return;                          // вычеркнутые — уже есть
    const { name, amount } = parseIng(scaleQty(String(ing), factor));
    if (!name) return;
    const op = { type: "shopping.add", name: cut(name, 120), amount: cut(amount, 200), recipe: r.id };
    const item = getData().shopping.find((it) => normName(it.name) === normName(op.name));
    if (item && item.contribs.some((c) => c.r === r.id && c.a === op.amount)) return;
    dispatch(op);
    added++;
  });
  return added;
}

export const removeShoppingItem = (name) => dispatch({ type: "shopping.remove", name });
export const checkShoppingItem = (name, checked) => dispatch({ type: "shopping.check", name, checked });
export const removeDish = (id) => dispatch({ type: "shopping.removeDish", slug: id });
export const clearShopping = () => dispatch({ type: "shopping.clear" });

// только на устройстве
export const toggleCheck = (id, kind, idx, on) => dispatch({ type: "checks.toggle", id, kind, idx, on });
export const resetChecks = (id) => dispatch({ type: "checks.reset", id });
export const pushRecent = (id) => dispatch({ type: "recent.push", id });
