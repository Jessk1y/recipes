// Подсказки названий продуктов для редактора рецептов: словарь корзины + названия из каталога,
// склеенные по canonKey (регистр, ё/е, синонимы, порядок слов) — в списке одно каноническое название.
import { canonKey, productEntries } from "./products.js";

export const norm = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// «Сметана 20% (жирная)» → «Сметана»; составные («А или Б», «А / Б», «А и Б») и длинные описания в подсказки не берём
export function cleanName(raw) {
  const s = String(raw).replace(/\([^)]*\)/g, " ").replace(/\s*\d+(?:[.,]\d+)?\s*%/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 40 || /\s(?:или|и)\s|\s\/\s/i.test(s)) return null;
  return s;
}

// rawNames — названия ингредиентов из каталога (с повторами: частота выбирает вариант написания)
export function buildSuggestions(rawNames) {
  const groups = new Map(); // canonKey → { dict, counts, terms }
  const group = (key) => groups.get(key) || groups.set(key, { dict: null, counts: new Map(), terms: new Set() }).get(key);
  for (const p of productEntries()) {
    const g = group(canonKey(p.name));
    g.dict = p.name;
    p.terms.filter((t) => !t.includes("(")).forEach((t) => g.terms.add(norm(t))); // «яйцо (желток)» — не синоним «яйца»
  }
  for (const raw of rawNames) {
    const name = cleanName(raw);
    if (!name) continue;
    const g = group(canonKey(name));
    g.counts.set(name, (g.counts.get(name) || 0) + 1);
    g.terms.add(norm(name));
  }
  return [...groups.values()].map((g) => {
    const best = [...g.counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
    return { name: cap(g.dict || best[0]), terms: [...g.terms] };
  });
}

// сначала названия, начинающиеся с введённого, затем те, чей синоним так начинается, затем содержащие его; внутри групп — по алфавиту
export function suggest(entries, query, max = 8) {
  const q = norm(query);
  if (!q) return [];
  const pre = [], syn = [], inc = [];
  for (const e of entries) {
    if (norm(e.name).startsWith(q)) pre.push(e);
    else if (e.terms.some((t) => t.startsWith(q))) syn.push(e);
    else if (norm(e.name).includes(q)) inc.push(e); // по синонимам — только с начала слова, чтобы «яйц» не тянул «Желток»
  }
  const byName = (a, b) => a.name.localeCompare(b.name, "ru");
  const list = [...pre.sort(byName), ...syn.sort(byName), ...inc.sort(byName)].slice(0, max);
  // единственный вариант, совпадающий с введённым, — подсказывать нечего
  return list.length === 1 && norm(list[0].name) === q ? [] : list;
}
