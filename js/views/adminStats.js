// Вкладка «Статистика» админки: сводка, графики по неделям (inline SVG, без библиотек), топ рецептов.
// Здесь только разметка из данных GET /admin/stats — чистые функции; загрузка и вкладки — в admin.js.
import { esc, plural } from "../lib/utils.js";

const fmt = (n) => Number(n).toLocaleString("ru-RU");

// «6 окт» для понедельника недели 'YYYY-MM-DD'
export function weekLabel(iso) {
  return new Date(iso + "T00:00:00Z")
    .toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" })
    .replace(/\./g, "");
}

// «красивый» верх шкалы: 1, 2, 5 × 10^k, не меньше max
export function niceMax(max) {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

// Столбчатый график по неделям. Последний столбец — текущая неделя (неполная), он бледнее.
export function barChart({ weeks, key, color, title, noun }) {
  const values = weeks.map((w) => w[key]);
  const total = values.reduce((s, v) => s + v, 0);
  const W = 640, H = 190, L = 34, R = 8, T = 18, B = 26;
  const top = niceMax(Math.max(...values, 0));
  const iw = W - L - R, ih = H - T - B;
  const bw = iw / values.length;
  const y = (v) => T + ih - (v / top) * ih;
  const step = Math.ceil(values.length / 7);
  const grid = [0, top / 2, top].map((g) =>
    `<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" class="st-grid"/>` +
    `<text x="${L - 5}" y="${y(g) + 3.5}" text-anchor="end" class="st-t">${fmt(Math.round(g * 10) / 10)}</text>`).join("");
  const bars = values.map((v, i) => {
    const x = L + i * bw + bw * 0.16, w = bw * 0.68, cur = i === values.length - 1;
    const h = Math.max(v > 0 ? 2 : 0, (v / top) * ih);
    const label = weekLabel(weeks[i].week);
    return `<g><title>${esc(`Неделя с ${label}${cur ? " (идёт)" : ""}: ${fmt(v)}`)}</title>` +
      `<rect x="${x.toFixed(1)}" y="${(T + ih - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}"${cur ? ' opacity=".55"' : ""}/>` +
      (v > 0 && values.length <= 16 ? `<text x="${(x + w / 2).toFixed(1)}" y="${(T + ih - h - 4).toFixed(1)}" text-anchor="middle" class="st-v">${fmt(v)}</text>` : "") +
      ((values.length - 1 - i) % step === 0
        ? `<text x="${(x + w / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="st-t">${esc(label)}</text>` : "") +
      `</g>`;
  }).join("");
  const label = `${title}: ${fmt(total)} ${noun} за ${values.length} ${plural(values.length, "неделю", "недели", "недель")}`;
  return `<figure class="st-chart"><figcaption>${esc(title)} <span class="st-sum">${fmt(total)} за ${values.length} нед.</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" class="st-svg">${grid}${bars}</svg></figure>`;
}

function card(label, value, sub) {
  return `<div class="st-card"><div class="st-card-v">${fmt(value)}</div><div class="st-card-l">${esc(label)}</div>` +
    (sub ? `<div class="st-card-s">${esc(sub)}</div>` : "") + `</div>`;
}

export function summaryHTML(s) {
  return `<div class="st-cards">
    ${card("Просмотров рецептов", s.views, `+${fmt(s.views7d)} за 7 дней`)}
    ${card("В избранном сейчас", s.favorites, "отметок ★ у пользователей")}
    ${card("В корзинах сейчас", s.cart, "блюд у пользователей")}
    ${card("Пользователей", s.users, `+${fmt(s.newUsers7d)} за 7 дней`)}
    ${card("Рецептов опубликовано", s.publishedRecipes)}
    ${card("Предложений", s.submissions, s.pendingSubmissions ? `${fmt(s.pendingSubmissions)} на модерации` : "на модерации нет")}
  </div>`;
}

export const TOP_SORTS = {
  views: { label: "Просмотры", icon: "👁" },
  favorites: { label: "Избранное", icon: "★" },
  cart: { label: "Корзина", icon: "🛒" },
};

// Топ рецептов по выбранной метрике (по умолчанию — просмотры); рецепты с нулём не показываются
export function topRows(recipes, sort = "views", limit = 10) {
  return [...recipes]
    .filter((r) => r[sort] > 0)
    .sort((a, b) => b[sort] - a[sort] || b.views - a.views || a.title.localeCompare(b.title, "ru"))
    .slice(0, limit);
}

export function topHTML(recipes, sort = "views") {
  const rows = topRows(recipes, sort);
  const max = rows.length ? rows[0][sort] : 1;
  const chips = Object.entries(TOP_SORTS).map(([k, v]) =>
    `<button class="tag-chip${k === sort ? " active" : ""}" data-sort="${k}">${v.icon} ${v.label}</button>`).join("");
  const body = rows.map((r, i) => `
    <li class="st-row">
      <span class="st-rank">${i + 1}</span>
      <div class="st-name"><a href="#/recipe/${encodeURIComponent(r.slug)}">${esc(r.title)}</a>
        <div class="st-bar"><span style="width:${Math.max(3, Math.round((r[sort] / max) * 100))}%"></span></div></div>
      <div class="st-nums">
        <span class="${sort === "views" ? "on" : ""}" title="Просмотры (за 7 дней: ${fmt(r.views7d)})">👁 ${fmt(r.views)}</span>
        <span class="${sort === "favorites" ? "on" : ""}" title="В избранном">★ ${fmt(r.favorites)}</span>
        <span class="${sort === "cart" ? "on" : ""}" title="В корзине">🛒 ${fmt(r.cart)}</span>
      </div>
    </li>`).join("");
  return `<div class="panel st-top"><h2>Топ рецептов</h2>
    <div class="st-sorts" id="stSorts">${chips}</div>
    <ol class="st-list">${body || `<li class="empty">Пока нет данных — просмотры начнут копиться после открытия рецептов</li>`}</ol></div>`;
}

export const PERIODS = [8, 12, 26];

export function statsHTML(data, { sort = "views", weeks = 12 } = {}) {
  const chips = PERIODS.map((n) => `<button class="tag-chip${n === weeks ? " active" : ""}" data-weeks="${n}">${n} нед.</button>`).join("");
  return `
    ${summaryHTML(data.summary)}
    <div class="st-period"><span class="hint">Период графиков:</span> ${chips}</div>
    <div class="st-charts">
      ${barChart({ weeks: data.weeks, key: "views", color: "var(--accent)", title: "👁 Просмотры по неделям", noun: "просмотров" })}
      ${barChart({ weeks: data.weeks, key: "newUsers", color: "#3f8fb0", title: "👤 Новые пользователи", noun: "пользователей" })}
      ${barChart({ weeks: data.weeks, key: "submissions", color: "#5aa06d", title: "📨 Предложения рецептов", noun: "предложений" })}
    </div>
    <p class="hint st-note">Недели — с понедельника, время UTC; последний столбец (бледный) — текущая неделя, она ещё не закончилась.
      Просмотр засчитывается не чаще раза в сутки с устройства; ни IP, ни аккаунт не сохраняются.</p>
    <div id="stTop">${topHTML(data.recipes, sort)}</div>`;
}
