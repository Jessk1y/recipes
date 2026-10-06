// ---------- Количества: разбор и сложение ----------
// parseAmount("1–1,5 стакана + 2 ст. л.") → части; sumAmounts([...], {density, pref}) → { text, ... }.
// Всё приводится к базовым единицам: г / мл / шт (+ «штучные» меры: зубчик, банка…).
// ч. л. = 5 мл, ст. л. = 15 мл, стакан = 250 мл. «По вкусу», «щепотка» и т. п. не складываются.
import { fmtNum, numOf, plural } from "./utils.js";

const FRAC = { "½": 0.5, "⅓": 1 / 3, "¼": 0.25, "¾": 0.75, "⅔": 2 / 3, "⅛": 0.125 };
const NUM = "(?:\\d+\\s+\\d+/\\d+|\\d+[.,]\\d+|\\d+/\\d+|\\d+\\s*[½⅓¼¾⅔⅛]|\\d+|[½⅓¼¾⅔⅛])";
const RANGE = new RegExp("^(" + NUM + ")(?:\\s*[–—-]\\s*(" + NUM + "))?");
const NOT_CYR = "(?![а-яёa-z])";

function toNum(tok) {
  tok = tok.trim();
  const m = tok.match(/^(\d+)?\s*([½⅓¼¾⅔⅛])$/);
  if (m) return (m[1] ? +m[1] : 0) + FRAC[m[2]];
  const mixed = tok.match(/^(\d+)\s+(\d+\/\d+)$/);
  if (mixed) return +mixed[1] + numOf(mixed[2]);
  return numOf(tok);
}

// Меры. dim: g | ml | pcs | u:<имя штучной меры>; k — множитель в базовую единицу;
// src — из какой меры пришёл объём (чтобы вернуть «ст. л.», «стакан», а не миллилитры).
const unit = (re, dim, k, src) => ({ re: new RegExp("^(?:" + re + ")" + NOT_CYR), dim, k, src: src || dim });
const UNITS = [
  unit("кг|килограмм\[а-яё]*", "g", 1000),
  unit("г|гр|грамм\[а-яё]*", "g", 1),
  unit("мл|миллилитр\[а-яё]*", "ml", 1),
  unit("л|литр\[а-яё]*", "ml", 1000),
  unit("ст\\.?\\s*л\\.?|стол\\.?\\s*ложк\[а-яё]*|столовая\\s+ложка|столовых\\s+ложек", "ml", 15, "spoon"),
  unit("ч\\.?\\s*л\\.?|чайн\\.?\\s*ложк\[а-яё]*|чайная\\s+ложка|чайных\\s+ложек", "ml", 5, "spoon"),
  unit("стакан\[а-яё]*", "ml", 250, "cup"),
  unit("шт\\.?|штук\[а-яё]*", "pcs", 1),
];
// штучные меры: суммируются только с такой же мерой. [один, несколько (2–4 и дроби), много]
const COUNT_UNITS = {
  зубчик: ["зубчик", "зубчика", "зубчиков"], плитка: ["плитка", "плитки", "плиток"],
  банка: ["банка", "банки", "банок"], упаковка: ["упаковка", "упаковки", "упаковок"],
  пачка: ["пачка", "пачки", "пачек"], кружка: ["кружка", "кружки", "кружек"],
  ломтик: ["ломтик", "ломтика", "ломтиков"], долька: ["долька", "дольки", "долек"],
  порция: ["порция", "порции", "порций"], пучок: ["пучок", "пучка", "пучков"],
  веточка: ["веточка", "веточки", "веточек"], кусок: ["кусок", "куска", "кусков"],
  горсть: ["горсть", "горсти", "горстей"],
};
const COUNT_STEMS = [
  ["зубчик", "зубчик\[а-яё]*"], ["плитка", "плитк\[а-яё]*"], ["банка", "банк\[а-яё]*"],
  ["упаковка", "упаков\[а-яё]*|упак\\.?"], ["пачка", "пачк\[а-яё]*"], ["кружка", "кружк\[а-яё]*"],
  ["ломтик", "ломтик\[а-яё]*"], ["долька", "дольк\[а-яё]*"], ["порция", "порц\[а-яё]*"],
  ["пучок", "пучок|пучк\[а-яё]*"], ["веточка", "веточк\[а-яё]*"], ["кусок", "кусок|куск\[а-яё]*|кусочек|кусочк\[а-яё]*"],
  ["горсть", "горсть|горст\[а-яё]*"],
].map(([k, re]) => ({ re: new RegExp("^(?:" + re + ")" + NOT_CYR), dim: "u:" + k, k: 1, src: "u:" + k }));
const SIZE_WORD = /^(?:небольш|средн|крупн|маленьк|больш)[а-яё]*$/;
// не количество, а пометка — не складывается, показывается как есть
const QUALITATIVE = /^(?:по\s|для\s|на\s|немного|много|чуть|щепот|оставш|сколько|при\s|любо|на кончике)/;

// «щепотка (по желанию, …)» → «щепотка»: пояснение в скобках не нужно, чтобы одинаковые пометки склеивались
const label = (s) => s.replace(/\s*\([^)]*\)/g, "").trim() || s;

// Часть строки количества → { dim, lo, hi, src } | { text, known }
function parsePart(raw) {
  const original = raw.trim();
  let s = original.toLowerCase().replace(/ё/g, "е");
  const parens = (s.match(/\(([^)]*)\)/) || [])[1] || "";
  s = s.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^(?:[≈~]|около\s+|примерно\s+)\s*/, "");
  if (!s) return null;

  const m = s.match(RANGE);
  if (!m) return { text: label(original), known: QUALITATIVE.test(s) };
  const lo = toNum(m[1]);
  const hi = m[2] ? toNum(m[2]) : lo;
  const rest = s.slice(m[0].length).trim();

  if (/^щепот/.test(rest)) return { text: label(original), known: true };
  let u = UNITS.find((x) => x.re.test(rest));
  const cu = !u && COUNT_STEMS.find((x) => x.re.test(rest));
  if (cu) {
    // «1,5 плитки (120 г)» — вес в скобках точнее штучной меры
    const w = parens.replace(/^[≈~]\s*/, "").match(new RegExp("^(" + NUM + ")\\s*(кг|г|гр|мл|л)" + NOT_CYR));
    if (w) {
      const wu = UNITS.find((x) => x.re.test(w[2]));
      const v = toNum(w[1]) * wu.k;
      return { dim: wu.dim, lo: v, hi: v, src: wu.src };
    }
    u = cu;
  }
  if (!u) {
    // «3–4 небольшие», «2» — штуки
    if (rest === "" || SIZE_WORD.test(rest.split(" ")[0])) u = { dim: "pcs", k: 1, src: "pcs" };
    else return { text: label(original), known: false };
  }
  return { dim: u.dim, lo: lo * u.k, hi: hi * u.k, src: u.src };
}

// "300 мл + 200 мл" → [часть, часть]; пустая строка → []
export function parseAmount(str) {
  return String(str || "").split(/\s*\+\s*(?![^(]*\))/).map(parsePart).filter(Boolean);
}

// ---------- Вывод ----------
const range = (lo, hi, fmt) => (Math.abs(hi - lo) < 1e-9 ? fmt(lo) : fmt(lo) + "–" + fmt(hi));

function fmtMass(lo, hi) {
  const kg = hi >= 1000;
  const f = (v) => fmtNum(kg ? v / 1000 : v < 10 ? Math.round(v * 10) / 10 : Math.round(v));
  return range(lo, hi, f) + (kg ? " кг" : " г");
}
// ст. л. и ч. л.: 20 мл → «1 ст. л. + 1 ч. л.»; null, если ровно не выходит
function spoons(ml) {
  const tbsp = Math.floor(ml / 15 + 1e-9);
  const tsp = Math.round(((ml - tbsp * 15) / 5) * 100) / 100;
  return { tbsp, tsp };
}
function fmtSpoons(lo, hi) {
  const a = spoons(lo), b = spoons(hi);
  if (lo === hi) {
    return [a.tbsp ? fmtNum(a.tbsp) + " ст. л." : "", a.tsp ? fmtNum(a.tsp) + " ч. л." : ""].filter(Boolean).join(" + ");
  }
  if (!a.tsp && !b.tsp) return range(a.tbsp, b.tbsp, fmtNum) + " ст. л.";
  if (!a.tbsp && !b.tbsp) return range(a.tsp, b.tsp, fmtNum) + " ч. л.";
  return null;
}
function fmtVolume(lo, hi, src) {
  const onlyBy = (name) => src.size > 0 && [...src].every((x) => x === name);
  if (onlyBy("spoon") && hi < 250) { const t = fmtSpoons(lo, hi); if (t) return t; }
  if (onlyBy("cup")) {
    const word = Number.isInteger(hi / 250) ? plural(hi / 250, "стакан", "стакана", "стаканов") : "стакана";
    return range(lo / 250, hi / 250, fmtNum) + " " + word;
  }
  if (hi >= 1000) return range(lo / 1000, hi / 1000, fmtNum) + " л";
  return range(lo, hi, (v) => fmtNum(Math.round(v * 10) / 10)) + " мл";
}
function fmtCount(dim, lo, hi) {
  if (dim === "pcs") return range(lo, hi, fmtNum) + " шт";
  const forms = COUNT_UNITS[dim.slice(2)];
  const word = Number.isInteger(hi) ? plural(hi, forms[0], forms[1], forms[2]) : forms[1];
  return range(lo, hi, fmtNum) + " " + word;
}

// Сумма списка строк количества. info: { density: г/мл или 0, pref: "g" | "ml" }.
// → { text, unknown: [строки, которые не разобрались], parts }
export function sumAmounts(amounts, info = {}) {
  const totals = new Map(); // dim → { lo, hi, src:Set }
  const texts = [], unknown = [];
  const add = (dim, lo, hi, src) => {
    const t = totals.get(dim) || { lo: 0, hi: 0, src: new Set() };
    t.lo += lo; t.hi += hi; t.src.add(src);
    totals.set(dim, t);
  };
  amounts.forEach((a) => parseAmount(a).forEach((p) => {
    if (p.text !== undefined) {
      if (!texts.some((t) => t.toLowerCase() === p.text.toLowerCase())) texts.push(p.text);
      if (!p.known) unknown.push(p.text);
    } else add(p.dim, p.lo, p.hi, p.src);
  }));

  const g = totals.get("g"), ml = totals.get("ml");
  if (g && ml && info.density) {
    if (info.pref === "ml") {
      totals.delete("g");
      add("ml", g.lo / info.density, g.hi / info.density, "ml");
    } else {
      totals.delete("ml");
      add("g", ml.lo * info.density, ml.hi * info.density, "g");
    }
  }

  const out = [];
  const gt = totals.get("g"), mt = totals.get("ml");
  if (gt) out.push(fmtMass(gt.lo, gt.hi));
  if (mt) out.push(fmtVolume(mt.lo, mt.hi, mt.src));
  const pcs = totals.get("pcs");
  if (pcs) out.push(fmtCount("pcs", pcs.lo, pcs.hi));
  totals.forEach((t, dim) => { if (dim.startsWith("u:")) out.push(fmtCount(dim, t.lo, t.hi)); });
  return { text: [...out, ...texts].join(" + "), unknown };
}
