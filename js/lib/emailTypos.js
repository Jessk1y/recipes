// Подсказка опечаток в популярных почтовых доменах: «gmial.com» → «gmail.com».
// Только совет: адрес не блокируется и сам не меняется.
const POPULAR = [
  "gmail.com", "yandex.ru", "yandex.com", "ya.ru", "mail.ru", "bk.ru", "inbox.ru", "list.ru",
  "rambler.ru", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com",
];

// расстояние Дамерау — Левенштейна (перестановка соседних букв = 1 правка)
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Возвращает исправленный адрес или null, если подсказывать нечего
export function suggestEmail(email) {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (domain.length < 4 || POPULAR.includes(domain)) return null;
  let best = null;
  for (const p of POPULAR) {
    const dist = distance(domain, p);
    if (dist <= 2 && dist <= Math.floor(p.length / 4) && (!best || dist < best.dist)) best = { p, dist };
  }
  return best ? email.slice(0, at + 1) + best.p : null;
}

export const isAsciiEmail = (email) => /^[\x21-\x7e]+$/.test(email);
