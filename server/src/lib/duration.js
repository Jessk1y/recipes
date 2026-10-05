// Та же логика, что stepSeconds() на фронтенде: первая длительность в тексте → секунды (0 — нет)
function durationSeconds(text) {
  text = String(text);
  const hreg = /(\d+(?:[.,]\d+)?)\s*(?:ч(?![а-яёА-ЯЁ])|час)(?:\s*(\d+)\s*мин)?/;
  const mreg = /(\d+)(?:\s*[–—-]\s*(\d+))?\s*мин/;
  const hm = text.match(hreg);
  const mm = text.match(mreg);
  const hi = hm ? hm.index : Infinity;
  const mi = mm ? mm.index : Infinity;
  if (hi === Infinity && mi === Infinity) return 0;
  if (hi <= mi) {
    let s = parseFloat(hm[1].replace(",", ".")) * 3600;
    if (hm[2]) s += +hm[2] * 60;
    return Math.round(s);
  }
  return (mm[2] ? +mm[2] : +mm[1]) * 60;
}

// «1,5 ч» → 90; пусто/неразобрано → null
const timeMinutes = (text) => Math.round(durationSeconds(text || "") / 60) || null;

module.exports = { durationSeconds, timeMinutes };
