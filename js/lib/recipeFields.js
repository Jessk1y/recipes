// Редактор рецепта: перевод между форматом хранения (ingredients: {kind, name, amount}, steps: {kind, text})
// и строками полей формы. Формат на сервере не меняется: количество по-прежнему одна строка («200 г»).
import { stepSeconds } from "./utils.js";

export const UNITS = ["г", "кг", "мл", "л", "ч. л.", "ст. л.", "стакан", "шт", "зубчик", "пучок", "щепотка", "по вкусу"];

// число, диапазон «2–3» или дробь «1/2» в начале строки количества
const QTY_RE = /^(\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?|[½¼¾⅓⅔])\s*(.*)$/;

// «200 г» → {qty:"200", unit:"г"}; «щепотка» → {qty:"", unit:"щепотка"}; «180 мл (полбанки)» → unit «мл (полбанки)»
export function splitAmount(amount) {
  const s = String(amount || "").trim();
  if (!s) return { qty: "", unit: "" };
  const m = s.match(QTY_RE);
  return m ? { qty: m[1], unit: m[2].trim() } : { qty: "", unit: s };
}
export const joinAmount = (qty, unit) => [String(qty).trim(), String(unit).trim()].filter(Boolean).join(" ") || null;

// Строка ингредиента: {h} — подзаголовок. orig — исходное количество: если поля не трогали, сохраняем его как было.
export function ingredientRows(list) {
  return list.map((i) => {
    if (i.kind === "HEADER") return { h: true, name: i.name };
    const { qty, unit } = splitAmount(i.amount);
    return { h: false, name: i.name, qty, unit, orig: i.amount || null, origQty: qty, origUnit: unit };
  });
}
export function ingredientsOut(rows) {
  return rows
    .map((r) => ({ ...r, name: r.name.trim() }))
    .filter((r) => r.name)
    .map((r) => {
      if (r.h) return { kind: "HEADER", name: r.name };
      const same = r.qty === r.origQty && r.unit === r.origUnit;
      return { kind: "ITEM", name: r.name, amount: same ? r.orig : joinAmount(r.qty, r.unit) };
    });
}

export function stepRows(list) {
  return list.map((s) => (s.kind === "HEADER"
    ? { h: true, text: s.text }
    : { h: false, text: s.text, timerSeconds: s.timerSeconds || null, origText: s.text }));
}
export function stepsOut(rows) {
  return rows
    .map((r) => ({ ...r, text: r.text.trim() }))
    .filter((r) => r.text)
    .map((r) => {
      if (r.h) return { kind: "HEADER", text: r.text };
      // ручной таймер сохраняем, пока текст шага не менялся; иначе сервер определит время по тексту
      const out = { kind: "ITEM", text: r.text };
      if (r.timerSeconds && r.text === (r.origText || "").trim()) out.timerSeconds = r.timerSeconds;
      return out;
    });
}

export const hasTime = (text) => stepSeconds(text) > 0;
