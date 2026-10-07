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

// слова про время, которые таймер шага не поймёт («полчаса», «пару минут», «10 секунд»)
const TIME_WORD = /(^|[^а-яё])(полчаса|получаса|час|часа|часов|мин|минут\p{L}*|сек|секунд\p{L}*|ночь|сутки)(?![а-яё])/iu;

/**
 * Недочёты рецепта для подсказок под предпросмотром. Работает по строкам редактора (ingredientRows/stepRows),
 * потому что пустые строки при сохранении молча отбрасываются — о них нужно предупредить заранее.
 * @param f {title, main[], image, time, servings, ing: rows, steps: rows}
 * @returns {string[]} тексты замечаний; пусто — всё в порядке
 */
export function recipeHints(f) {
  const out = [];
  const trim = (s) => String(s || "").trim();
  if (!trim(f.title)) out.push("Не указано название.");
  if (!(f.main || []).length) out.push("Не отмечен ни один основной тег — рецепт не попадёт в фильтр на главной.");
  if (!f.image) out.push("Нет фото — вместо него будет эмодзи.");
  if (!trim(f.time)) out.push("Не указано время приготовления.");
  if (!trim(f.servings)) out.push("Не указаны порции.");

  const ing = f.ing || [];
  const emptyIng = ing.filter((r) => !trim(r.name)).length;
  if (emptyIng) out.push(`Пустых строк в ингредиентах: ${emptyIng} — при сохранении они пропадут.`);
  if (!ing.some((r) => !r.h && trim(r.name))) out.push("Нет ни одного ингредиента.");

  const steps = f.steps || [];
  let n = 0;
  steps.forEach((r) => {
    if (r.h) return;
    n++;
    const text = trim(r.text);
    if (!text) out.push(`Шаг ${n} пустой — при сохранении он пропадёт.`);
    else if (!hasTime(text) && TIME_WORD.test(text)) out.push(`Шаг ${n}: упоминается время, но таймер не распознан — напишите, например, «30 мин».`);
  });
  if (!steps.some((r) => !r.h && trim(r.text))) out.push("Нет ни одного шага.");
  return out;
}
