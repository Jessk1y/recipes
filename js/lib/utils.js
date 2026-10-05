// ---------- Утилиты ----------
export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Время в минутах из строки вроде "1 ч 10 мин", "40 мин", "1,5 ч"
export function parseMinutes(t) {
  if (!t) return null;
  let total = 0, found = false;
  const h = String(t).match(/(\d+(?:[.,]\d+)?)\s*ч/);
  const m = String(t).match(/(\d+)\s*мин/);
  if (h) { total += parseFloat(h[1].replace(",", ".")) * 60; found = true; }
  if (m) { total += parseInt(m[1], 10); found = true; }
  return found ? Math.round(total) : null;
}

// Секунды для таймера из текста шага (берём первое упоминание времени)
export function stepSeconds(text) {
  text = String(text);
  const hreg = /(\d+(?:[.,]\d+)?)\s*(?:ч(?![а-яёА-ЯЁ])|час)(?:\s*(\d+)\s*мин)?/;
  const mreg = /(\d+)(?:\s*[–—-]\s*(\d+))?\s*мин/;
  const hm = text.match(hreg), mm = text.match(mreg);
  const hi = hm ? hm.index : Infinity, mi = mm ? mm.index : Infinity;
  if (hi === Infinity && mi === Infinity) return 0;
  if (hi <= mi) {
    let s = parseFloat(hm[1].replace(",", ".")) * 3600;
    if (hm[2]) s += (+hm[2]) * 60;
    return Math.round(s);
  }
  return (mm[2] ? +mm[2] : +mm[1]) * 60;
}

// Масштабирование количеств в строке ингредиента
const SCALE_UNIT = "(?:кг|г|мл|л|шт|ст\\.?\\s*л\\.?|ч\\.?\\s*л\\.?|стакан\\w*|зубчик\\w*|плитк\\w*|банк\\w*|кружк\\w*|пачк\\w*|дольк\\w*|щепот\\w*|горст\\w*|ломтик\\w*|порц\\w*)";
function fmtNum(n) {
  n = Math.round(n * 100) / 100;
  let s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return s.replace(".", ",");
}
function numOf(tok) {
  if (tok.indexOf("/") >= 0) { const [a, b] = tok.split("/"); return (+a) / (+b); }
  return parseFloat(tok.replace(",", "."));
}
export function scaleQty(str, f) {
  if (!f || f === 1) return str;
  const QTY = "\\d+(?:[.,]\\d+)?(?:/\\d+)?";
  const re = new RegExp("(" + QTY + ")(\\s*[–—-]\\s*(" + QTY + "))?\\s*(?=" + SCALE_UNIT + "(?![А-Яа-яЁёA-Za-z]))", "g");
  return str.replace(re, (m, a, rng, b) => {
    let out = fmtNum(numOf(a) * f);
    if (b) out += "–" + fmtNum(numOf(b) * f);
    return out + " ";
  });
}

export function fmtClock(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

export function shorten(s, n) { s = String(s); return s.length > n ? s.slice(0, n).trim() + "…" : s; }

// Разбор "Название — количество" (разделитель — длинное тире U+2014)
export function parseIng(str) {
  str = String(str).trim();
  const i = str.indexOf("—");
  if (i < 0) return { name: str, amount: "" };
  return { name: str.slice(0, i).trim(), amount: str.slice(i + 1).trim() };
}
// Ключ слияния позиций списка покупок — то же правило, что server/src/lib/normName.js
export function normName(n) { return String(n).trim().toLowerCase().replace(/\s+/g, " "); }

// Склонение: plural(5, "изменение", "изменения", "изменений") → "изменений"
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

// ---------- Тосты ----------
let toastTimer = null;
export function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------- Эмодзи-заглушка ----------
const EMOJI = {
  Завтраки: "🍳", Супы: "🍲", Салаты: "🥗", Ужины: "🍽️", Десерты: "🍰",
  Выпечка: "🥐", Напитки: "🥤",
  Первое: "🍲", Второе: "🍽️", Десерт: "🍰", Напиток: "🥤",
  Курица: "🍗", Свинина: "🥩", Говядина: "🥩", Шоколад: "🍫",
};
export function emojiFor(r) {
  for (const k of [...(r.main || []), r.category]) if (EMOJI[k]) return EMOJI[k];
  return "🍴";
}
