// Тесты статистики на фронтенде: учёт «раз в сутки с устройства» и разметка графиков/топа: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { dueForView, markViewed, VIEW_TTL } from "../js/lib/viewLog.js";
import { niceMax, barChart, topRows, topHTML, summaryHTML, statsHTML, weekLabel } from "../js/views/adminStats.js";

const NOW = Date.UTC(2026, 9, 6, 12);

test("просмотр шлётся не чаще раза в сутки на рецепт", () => {
  assert.equal(dueForView({}, "borsch", NOW), true);
  assert.equal(dueForView(undefined, "borsch", NOW), true);
  const log = markViewed({}, "borsch", NOW);
  assert.equal(dueForView(log, "borsch", NOW + 1000), false);
  assert.equal(dueForView(log, "borsch", NOW + VIEW_TTL - 1), false);
  assert.equal(dueForView(log, "borsch", NOW + VIEW_TTL), true);
  assert.equal(dueForView(log, "shaurma", NOW + 1000), true, "другой рецепт считается отдельно");
});

test("часы переведены назад или мусор в логе — просмотр всё равно отправится", () => {
  assert.equal(dueForView({ a: NOW + 5 * VIEW_TTL }, "a", NOW), true);
  assert.equal(dueForView({ a: "вчера" }, "a", NOW), true);
  assert.equal(dueForView({ a: null }, "a", NOW), true);
});

test("лог не растёт: записи старше суток и мусор выбрасываются, свежие остаются", () => {
  const log = markViewed({ old: NOW - VIEW_TTL - 1, fresh: NOW - 1000, junk: "x", future: NOW + 1e9 }, "new", NOW);
  assert.deepEqual(Object.keys(log).sort(), ["fresh", "new"]);
  assert.equal(log.new, NOW);
});

test("niceMax: 1/2/5 × 10^k", () => {
  assert.deepEqual([0, 1, 2, 3, 5, 6, 11, 99, 101, 250, 501].map(niceMax), [1, 1, 2, 5, 5, 10, 20, 100, 200, 500, 1000]);
});

const weeks = (vals) => vals.map((v, i) => ({ week: `2026-0${1 + (i % 9)}-05`, views: v, newUsers: 0, submissions: 0 }));

test("график: столбец на каждую неделю, последний бледный, значения в подсказках", () => {
  const svg = barChart({ weeks: weeks([0, 3, 12]), key: "views", color: "red", title: "Просмотры", noun: "просмотров" });
  assert.equal((svg.match(/<rect /g) || []).length, 3);
  assert.equal((svg.match(/opacity="\.55"/g) || []).length, 1);
  assert.match(svg, /aria-label="Просмотры: 15 просмотров за 3 недели"/);
  assert.match(svg, /<title>Неделя с 5 мар?[^<]*|<title>Неделя с/);
});

test("график из одних нулей не ломается (нет NaN/Infinity)", () => {
  const svg = barChart({ weeks: weeks(new Array(12).fill(0)), key: "views", color: "red", title: "t", noun: "n" });
  assert.ok(!/NaN|Infinity/.test(svg));
  assert.equal((svg.match(/<rect /g) || []).length, 12);
});

test("в разметку попадает только экранированный текст", () => {
  const r = [{ slug: "x", title: "<img src=x onerror=alert(1)>", views: 5, views7d: 1, favorites: 1, cart: 0 }];
  const html = topHTML(r, "views");
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(!barChart({ weeks: weeks([1]), key: "views", color: "red", title: "<b>", noun: "n" }).includes("<b>"));
});

test("топ: сортировка по выбранной метрике, нули не показываются, максимум 10", () => {
  const rs = Array.from({ length: 14 }, (_, i) => ({ slug: "r" + i, title: "Р" + i, views: i, views7d: 0, favorites: 14 - i, cart: i % 2 ? 1 : 0 }));
  assert.deepEqual(topRows(rs, "views").map((r) => r.slug)[0], "r13");
  assert.equal(topRows(rs, "views").length, 10);
  assert.ok(topRows(rs, "views").every((r) => r.views > 0), "r0 с нулём просмотров не в топе");
  assert.equal(topRows(rs, "favorites")[0].slug, "r0");
  assert.equal(topRows(rs, "cart").length, 7);
  assert.match(topHTML([], "views"), /Пока нет данных/);
});

test("страница статистики целиком: сводка, три графика, топ, переключатели", () => {
  const data = {
    summary: { views: 1234, views7d: 56, favorites: 7, cart: 3, users: 12, newUsers7d: 2, publishedRecipes: 19, submissions: 4, pendingSubmissions: 1 },
    weeks: weeks([1, 2, 3, 4]),
    recipes: [{ slug: "borsch", title: "Борщ", views: 10, views7d: 4, favorites: 2, cart: 1 }],
  };
  const html = statsHTML(data, { sort: "favorites", weeks: 8 });
  assert.equal((html.match(/class="st-chart"/g) || []).length, 3);
  assert.match(html, /1\s?234/);
  assert.match(html, /\+56 за 7 дней/);
  assert.match(html, /1 на модерации/);
  assert.match(html, /data-weeks="8"/);
  assert.match(html, /data-sort="favorites"/);
  assert.match(html, /tag-chip active" data-sort="favorites"/);
  assert.match(summaryHTML({ ...data.summary, pendingSubmissions: 0 }), /на модерации нет/);
});

test("метка недели — день и месяц без точки", () => {
  assert.match(weekLabel("2026-10-05"), /^5 окт/);
  assert.ok(!weekLabel("2026-10-05").includes("."));
});
