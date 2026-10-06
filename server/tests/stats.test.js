// Статистика: права на /admin/stats, публичный счётчик просмотров (лимит, отсутствие личных данных),
// агрегаты избранного/корзины/пользователей/предложений и недельные графики.
// Идёт в отдельной схеме Postgres: статистика считает всех пользователей и все рецепты в БД, а наборы тестов
// выполняются параллельно — общая схема давала бы случайные расхождения (и мои опубликованные рецепты
// сбивали бы проверку версии snapshot в recipes.test.js).
const { execSync } = require("node:child_process");
const path = require("node:path");

require("dotenv").config();
const testUrl = new URL(process.env.DATABASE_URL);
testUrl.searchParams.set("schema", "recipes_stats_test");
process.env.DATABASE_URL = testUrl.toString(); // dotenv не перезаписывает уже заданные переменные
process.env.NODE_ENV = "test";
process.env.STORAGE_DRIVER = "local";
execSync("node node_modules/prisma/build/index.js migrate deploy", { cwd: path.join(__dirname, ".."), stdio: "pipe" });

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../src/app");
const prisma = require("../src/lib/prisma");
const limiters = require("../src/middleware/rateLimits");
const { signAccessToken } = require("../src/lib/jwt");
const { weekKeys } = require("../src/modules/stats/stats.service");

const T = `zs${Date.now().toString(36)}`;
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const as = (u, m, url) => api(m, url).set("Authorization", `Bearer ${u.token}`);
const U = {}; // имя → { id, token }
const R = {}; // имя → recipe
const slugOf = (n) => `stat-${T}-${n}`;
const stats = async (q = "") => {
  const r = await as(U.admin, "get", `/admin/stats${q}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const rec = (body, name) => body.recipes.find((r) => r.slug === slugOf(name));

async function mkUser(name, data = {}) {
  const u = await prisma.user.create({
    data: { email: `${name}-${T}@stats-test.example.com`, passwordHash: "x", displayName: name, emailVerifiedAt: new Date(), ...data },
  });
  U[name] = { id: u.id, token: signAccessToken(u) };
}

let categoryId;
before(async () => {
  categoryId = (await prisma.category.create({ data: { name: `Тест ${T}`, slug: `test-${T}` } })).id;
  for (const [n, status] of [["a", "PUBLISHED"], ["b", "PUBLISHED"], ["c", "PUBLISHED"], ["draft", "DRAFT"]]) {
    R[n] = await prisma.recipe.create({ data: { slug: slugOf(n), title: `Блюдо ${n} ${T}`, categoryId, status } });
  }
  await mkUser("admin", { role: "ADMIN" });
  await mkUser("alice");
  await mkUser("bob");
  await mkUser("exAdmin"); // роль в токене — ADMIN, но в БД уже USER
  U.exAdmin.token = signAccessToken({ id: U.exAdmin.id, email: "x", role: "ADMIN" });
  await mkUser("blockedAdmin", { role: "ADMIN", isBlocked: true });
});
beforeEach(() => limiters.resetAll());
after(async () => {
  const ids = Object.values(U).map((u) => u.id);
  await prisma.recipe.deleteMany({ where: { slug: { contains: T } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.category.deleteMany({ where: { slug: `test-${T}` } });
  await prisma.$disconnect();
});

// ---------- права ----------

test("/admin/stats: гость и мусорный токен — 401; обычный, разжалованный и заблокированный админ — 403", async () => {
  assert.equal((await api("get", "/admin/stats")).status, 401);
  assert.equal((await api("get", "/admin/stats").set("Authorization", "Bearer junk")).status, 401);
  for (const name of ["alice", "exAdmin", "blockedAdmin"]) {
    const r = await as(U[name], "get", "/admin/stats");
    assert.equal(r.status, 403, name);
    assert.equal(r.body.error.code, name === "blockedAdmin" ? "ACCOUNT_BLOCKED" : "FORBIDDEN", name);
    assert.equal(r.body.recipes, undefined, `${name}: данные не утекли`);
  }
  assert.equal((await as(U.admin, "get", "/admin/stats")).status, 200);
});

test("статистика не отдаётся админу через чужие пути: POST /stats/view не требует прав и не читает данные", async () => {
  const r = await api("post", "/stats/view").send({ slug: slugOf("c") });
  assert.equal(r.status, 204);
  assert.equal(r.text, "");
  assert.equal((await api("get", "/stats/view")).status, 404, "читать счётчик по публичному пути нельзя");
});

// ---------- просмотры ----------

test("просмотр: 204, счётчик растёт на 1; рецепт появляется в статистике админа", async () => {
  const before = rec(await stats(), "a");
  assert.deepEqual([before.views, before.views7d], [0, 0]);
  for (let i = 0; i < 3; i++) assert.equal((await api("post", "/stats/view").send({ slug: slugOf("a") })).status, 204);
  const after = rec(await stats(), "a");
  assert.equal(after.views, 3);
  assert.equal(after.views7d, 3);
  assert.equal(rec(await stats(), "b").views, 0);
});

test("черновик и неизвестный slug: тот же 204, но ничего не записывается", async () => {
  assert.equal((await api("post", "/stats/view").send({ slug: slugOf("draft") })).status, 204);
  assert.equal((await api("post", "/stats/view").send({ slug: `net-takogo-${T}` })).status, 204);
  assert.equal(await prisma.recipeView.count({ where: { recipeId: R.draft.id } }), 0);
  assert.equal(rec(await stats(), "draft"), undefined, "черновики в статистике не показываются");
});

test("некорректный ввод: нет slug, заглавные буквы, спецсимволы, слишком длинный — 422", async () => {
  for (const body of [undefined, {}, { slug: "" }, { slug: "ABC" }, { slug: "a b" }, { slug: "a'; drop table x;--" }, { slug: "-a" }, { slug: "a".repeat(201) }, { slug: 5 }]) {
    const r = await api("post", "/stats/view").send(body);
    assert.equal(r.status, 422, JSON.stringify(body));
  }
});

test("без личных данных: в таблице просмотров только рецепт, день и счётчик", async () => {
  const cols = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'recipe_views' AND table_schema = current_schema() ORDER BY column_name`;
  assert.deepEqual(cols.map((c) => c.column_name), ["count", "day", "recipe_id"]);
  // запрос с токеном пользователя и своими заголовками тоже ничего о нём не сохраняет: строка одна на (рецепт, день)
  await as(U.alice, "post", "/stats/view").set("X-Forwarded-For", "203.0.113.7").set("User-Agent", "secret-agent").send({ slug: slugOf("b") });
  await api("post", "/stats/view").send({ slug: slugOf("b") });
  const rows = await prisma.recipeView.findMany({ where: { recipeId: R.b.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["count", "day", "recipeId"]);
});

test("rate-limit: после порога 429 RATE_LIMITED, счётчик не растёт; общий лимит записи просмотрами не расходуется", async () => {
  const { view, write } = limiters.limits;
  const [viewLimit, writeLimit] = [view.limit, write.limit];
  try {
    view.limit = 3;
    write.limit = 1;
    const before = rec(await stats(), "a").views;
    for (let i = 0; i < 3; i++) assert.equal((await api("post", "/stats/view").send({ slug: slugOf("a") })).status, 204, `#${i}`);
    const r = await api("post", "/stats/view").send({ slug: slugOf("a") });
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, "RATE_LIMITED");
    view.limit = viewLimit;
    limiters.resetAll(); // заодно сбросили счётчик write
    write.limit = 1;
    assert.equal(rec(await stats(), "a").views, before + 3, "четвёртый просмотр не засчитан");
    // write=1: два просмотра подряд проходят — они в write-лимит не входят
    assert.equal((await api("post", "/stats/view").send({ slug: slugOf("b") })).status, 204);
    assert.equal((await api("post", "/stats/view").send({ slug: slugOf("b") })).status, 204);
  } finally {
    view.limit = viewLimit;
    write.limit = writeLimit;
  }
});

// ---------- агрегаты ----------

test("избранное и корзина: считаются по пользователям, черновик исключён, чужие данные наружу не уходят", async () => {
  await prisma.favorite.createMany({ data: [{ userId: U.alice.id, recipeId: R.a.id }, { userId: U.bob.id, recipeId: R.a.id }, { userId: U.bob.id, recipeId: R.b.id }] });
  // у alice два продукта от одного блюда — в «корзине» она всё равно один пользователь
  for (const [user, name] of [[U.alice, "Мука"], [U.alice, "Сахар"], [U.bob, "Мука"]]) {
    const item = await prisma.shoppingItem.create({ data: { userId: user.id, name, normName: `${name}-${T}` } });
    await prisma.shoppingContrib.create({ data: { itemId: item.id, recipeId: R.a.id, amount: "1" } });
  }
  const manual = await prisma.shoppingItem.create({ data: { userId: U.alice.id, name: "Соль", normName: `соль-${T}` } });
  await prisma.shoppingContrib.create({ data: { itemId: manual.id, recipeId: null } }); // добавлено вручную — к рецептам не относится

  const body = await stats();
  const a = rec(body, "a");
  assert.equal(a.favorites, 2);
  assert.equal(a.cart, 2);
  assert.equal(rec(body, "b").favorites, 1);
  assert.equal(rec(body, "b").cart, 0);
  const text = JSON.stringify(body);
  for (const secret of [U.alice.id, U.bob.id, `alice-${T}`, "stats-test.example.com", "Мука", "Сахар"]) {
    assert.ok(!text.includes(secret), `в ответе не должно быть: ${secret}`);
  }
});

test("сводка и недели: новые пользователи и предложения попадают в текущую неделю, недели — с понедельника", async () => {
  const base = await stats();
  await mkUser("newbie");
  await prisma.recipe.create({
    data: { slug: slugOf("sub"), title: `Предложка ${T}`, categoryId, status: "PENDING", authorId: U.newbie.id, submittedAt: new Date() },
  });
  await prisma.recipe.create({
    data: { slug: slugOf("old"), title: `Старая ${T}`, categoryId, status: "REJECTED", authorId: U.newbie.id, submittedAt: new Date(Date.now() - 30 * 86400000) },
  });
  const now = await stats();
  const last = (b) => b.weeks[b.weeks.length - 1];

  assert.equal(now.summary.users, base.summary.users + 1);
  assert.equal(now.summary.newUsers7d, base.summary.newUsers7d + 1);
  assert.equal(now.summary.submissions, base.summary.submissions + 2);
  assert.equal(now.summary.pendingSubmissions, base.summary.pendingSubmissions + 1);
  assert.equal(last(now).newUsers, last(base).newUsers + 1);
  assert.equal(last(now).submissions, last(base).submissions + 1, "старое предложение — в своей неделе, не в текущей");

  assert.equal(now.weeks.length, 12);
  assert.deepEqual(now.weeks.map((w) => w.week), weekKeys(12));
  for (const w of now.weeks) {
    assert.equal(new Date(w.week + "T00:00:00Z").getUTCDay(), 1, `${w.week} — понедельник`);
    assert.ok(w.views >= 0 && w.newUsers >= 0 && w.submissions >= 0);
  }
  assert.equal(last(now).views, now.weeks.reduce((s, w) => s + w.views, 0) - now.weeks.slice(0, -1).reduce((s, w) => s + w.views, 0));
});

test("недели: ?weeks= ограничивает период (1–52), иначе 422", async () => {
  assert.equal((await stats("?weeks=4")).weeks.length, 4);
  assert.equal((await stats("?weeks=52")).weeks.length, 52);
  for (const w of ["0", "53", "-1", "abc", "1.5"]) {
    assert.equal((await as(U.admin, "get", `/admin/stats?weeks=${w}`)).status, 422, `weeks=${w}`);
  }
});

test("просмотры суммируются по неделям и дням: вчерашние — в views, но не в «за 7 дней», если старше недели", async () => {
  await prisma.$executeRaw`DELETE FROM recipe_views WHERE recipe_id = ${R.b.id}::uuid`;
  await prisma.$executeRaw`INSERT INTO recipe_views (recipe_id, day, count) VALUES
    (${R.b.id}::uuid, (now() AT TIME ZONE 'UTC')::date, 2),
    (${R.b.id}::uuid, (now() AT TIME ZONE 'UTC')::date - 20, 5)`;
  const body = await stats();
  const b = rec(body, "b");
  assert.equal(b.views, 7);
  assert.equal(b.views7d, 2);
  assert.ok(body.weeks.reduce((s, w) => s + w.views, 0) >= 7, "обе записи попали в график (20 дней < 12 недель)");
  assert.deepEqual(body.recipes.map((r) => r.views), [...body.recipes.map((r) => r.views)].sort((x, y) => y - x), "список отсортирован по просмотрам");
});

test("удаление рецепта убирает и его просмотры (каскад)", async () => {
  const tmp = await prisma.recipe.create({ data: { slug: slugOf("tmp"), title: `Временный ${T}`, categoryId } });
  await api("post", "/stats/view").send({ slug: tmp.slug });
  assert.equal(await prisma.recipeView.count({ where: { recipeId: tmp.id } }), 1);
  await prisma.recipe.delete({ where: { id: tmp.id } });
  assert.equal(await prisma.recipeView.count({ where: { recipeId: tmp.id } }), 0);
});

test("weekKeys: понедельник UTC, воскресенье относится к прошлой неделе", () => {
  assert.deepEqual(weekKeys(3, new Date("2026-10-07T12:00:00Z")), ["2026-09-21", "2026-09-28", "2026-10-05"]);
  assert.equal(weekKeys(1, new Date("2026-10-11T23:59:59Z"))[0], "2026-10-05");
  assert.equal(weekKeys(1, new Date("2026-10-12T00:00:00Z"))[0], "2026-10-12");
});
