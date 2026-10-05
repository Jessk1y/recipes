// Интеграционные тесты me / shopping / sync. Нужна БД из DATABASE_URL.
// Главная проверка — изоляция: пользователь видит и меняет только свои данные.
process.env.NODE_ENV = "test";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcrypt");
const app = require("../src/app");
const prisma = require("../src/lib/prisma");
const shoppingService = require("../src/modules/shopping/shopping.service");

const T = `zm${Date.now().toString(36)}`;
const PASSWORD = "test-password-1";
const emails = { a: `a-${T}@example.com`, b: `b-${T}@example.com` };
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const as = (token, m, url) => api(m, url).set("Authorization", `Bearer ${token}`);
const slugs = { r1: `r1-${T}`, r2: `r2-${T}`, draft: `draft-${T}` };
let A, B; // access-токены

before(async () => {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  for (const [k, email] of Object.entries(emails)) {
    await prisma.user.create({ data: { email, passwordHash, displayName: k.toUpperCase() } });
  }
  const category = await prisma.category.create({ data: { name: `Кат ${T}`, slug: `cat-${T}` } });
  for (const [k, slug] of Object.entries(slugs)) {
    await prisma.recipe.create({
      data: { slug, title: `Рецепт ${k} ${T}`, categoryId: category.id, status: k === "draft" ? "DRAFT" : "PUBLISHED" },
    });
  }
  const login = async (email) => (await api("post", "/auth/login").send({ email, password: PASSWORD })).body.accessToken;
  A = await login(emails.a);
  B = await login(emails.b);
});

after(async () => {
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }); // каскадно чистит личные данные
  await prisma.recipe.deleteMany({ where: { title: { contains: T } } });
  await prisma.category.deleteMany({ where: { name: { contains: T } } });
  await prisma.$disconnect();
});

const ago = (ms) => new Date(Date.now() - ms).toISOString();

// ---------- доступ ----------

test("все эндпоинты me/shopping/sync требуют авторизации (без токена и с мусорным токеном → 401)", async () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const routes = [
    ["get", "/me/favorites"], ["put", `/me/favorites/${slugs.r1}`], ["delete", `/me/favorites/${slugs.r1}`],
    ["get", "/me/notes"], ["put", `/me/notes/${slugs.r1}`], ["delete", `/me/notes/${slugs.r1}`],
    ["get", "/me/shopping"], ["delete", "/me/shopping"], ["post", "/me/shopping/items"],
    ["patch", `/me/shopping/items/${id}`], ["delete", `/me/shopping/items/${id}`],
    ["delete", `/me/shopping/dishes/${slugs.r1}`], ["post", "/me/sync"],
  ];
  for (const [m, url] of routes) {
    const guest = await api(m, url).send({});
    assert.equal(guest.status, 401, `${m} ${url} без токена`);
    const junk = await api(m, url).set("Authorization", "Bearer junk").send({});
    assert.equal(junk.status, 401, `${m} ${url} с мусорным токеном`);
  }
});

// ---------- избранное ----------

test("избранное: добавление идемпотентно, список, удаление; черновик и неизвестный slug → 404", async () => {
  assert.equal((await as(A, "put", `/me/favorites/${slugs.r1}`)).status, 204);
  assert.equal((await as(A, "put", `/me/favorites/${slugs.r1}`)).status, 204);
  assert.equal((await as(A, "put", `/me/favorites/${slugs.r2}`)).status, 204);
  const list = await as(A, "get", "/me/favorites");
  assert.deepEqual(list.body.items.map((f) => f.slug).sort(), [slugs.r1, slugs.r2].sort());

  assert.equal((await as(A, "put", `/me/favorites/${slugs.draft}`)).status, 404);
  assert.equal((await as(A, "put", "/me/favorites/net-takogo")).status, 404);

  assert.equal((await as(A, "delete", `/me/favorites/${slugs.r2}`)).status, 204);
  assert.equal((await as(A, "delete", `/me/favorites/${slugs.r2}`)).status, 204); // повтор безвреден
  assert.deepEqual((await as(A, "get", "/me/favorites")).body.items.map((f) => f.slug), [slugs.r1]);
});

test("ИЗОЛЯЦИЯ избранного: B не видит избранное A, а удаление у B не трогает A", async () => {
  assert.deepEqual((await as(B, "get", "/me/favorites")).body.items, []);
  assert.equal((await as(B, "delete", `/me/favorites/${slugs.r1}`)).status, 204);
  assert.equal((await as(A, "get", "/me/favorites")).body.items.length, 1);
});

// ---------- заметки ----------

test("заметки: сохранить, обновить, пустой текст удаляет, лимит 2000 → 422", async () => {
  const put = await as(A, "put", `/me/notes/${slugs.r1}`).send({ text: "меньше соли" });
  assert.equal(put.status, 200);
  assert.equal(put.body.text, "меньше соли");
  await as(A, "put", `/me/notes/${slugs.r1}`).send({ text: "меньше соли, больше перца" });
  const list = await as(A, "get", "/me/notes");
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].text, "меньше соли, больше перца");

  assert.equal((await as(A, "put", `/me/notes/${slugs.r1}`).send({ text: "x".repeat(2001) })).status, 422);
  assert.equal((await as(A, "put", `/me/notes/${slugs.draft}`).send({ text: "x" })).status, 404);

  assert.equal((await as(A, "put", `/me/notes/${slugs.r1}`).send({ text: "   " })).status, 204);
  assert.deepEqual((await as(A, "get", "/me/notes")).body.items, []);
});

test("ИЗОЛЯЦИЯ заметок: B не видит заметку A; своя заметка B не перезаписывает заметку A", async () => {
  await as(A, "put", `/me/notes/${slugs.r2}`).send({ text: "заметка A" });
  assert.deepEqual((await as(B, "get", "/me/notes")).body.items, []);

  await as(B, "put", `/me/notes/${slugs.r2}`).send({ text: "заметка B" });
  assert.equal((await as(A, "get", "/me/notes")).body.items[0].text, "заметка A");
  assert.equal((await as(B, "get", "/me/notes")).body.items[0].text, "заметка B");

  await as(B, "delete", `/me/notes/${slugs.r2}`);
  assert.equal((await as(A, "get", "/me/notes")).body.items[0].text, "заметка A");
  await as(A, "delete", `/me/notes/${slugs.r2}`);
});

// ---------- список покупок ----------

test("покупки: слияние по названию, contribs как на фронте, без дублей вклада, порядок добавления", async () => {
  const add = (items) => as(A, "post", "/me/shopping/items").send({ items });
  let r = await add([
    { name: "Мука", amount: "200 г", recipe: slugs.r1 },
    { name: "Яйца", amount: "2 шт", recipe: slugs.r1 },
  ]);
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 2);

  r = await add([
    { name: "  мука ", amount: "2 ст.л.", recipe: slugs.r2 }, // слияние по normName
    { name: "Мука", amount: "200 г", recipe: slugs.r1 }, // тот же вклад — не дублируется
    { name: "Соль" }, // вручную, без блюда
  ]);
  assert.equal(r.body.added, 2);
  const items = r.body.items;
  assert.deepEqual(items.map((i) => i.name), ["Мука", "Яйца", "Соль"]);
  assert.deepEqual(items[0].contribs, [{ r: slugs.r1, a: "200 г" }, { r: slugs.r2, a: "2 ст.л." }]);
  assert.deepEqual(items[2].contribs, [{ r: null, a: "" }]);
  assert.equal(items[0].checked, false);
});

test("покупки: неизвестное блюдо → 404 и ничего не добавляется; пустое имя → 422", async () => {
  const count = (await as(A, "get", "/me/shopping")).body.items.length;
  const r = await as(A, "post", "/me/shopping/items").send({
    items: [{ name: "Сахар", recipe: slugs.r1 }, { name: "Перец", recipe: "net-takogo" }],
  });
  assert.equal(r.status, 404);
  assert.equal((await as(A, "get", "/me/shopping")).body.items.length, count);
  assert.equal((await as(A, "post", "/me/shopping/items").send({ items: [{ name: " " }] })).status, 422);
});

test("ИЗОЛЯЦИЯ покупок: B не видит список A и не может ни изменить, ни удалить его позиции", async () => {
  const items = (await as(A, "get", "/me/shopping")).body.items;
  const flour = items.find((i) => i.name === "Мука");
  assert.deepEqual((await as(B, "get", "/me/shopping")).body.items, []);

  assert.equal((await as(B, "patch", `/me/shopping/items/${flour.id}`).send({ checked: true })).status, 404);
  assert.equal((await as(B, "delete", `/me/shopping/items/${flour.id}`)).status, 404);
  await as(B, "delete", `/me/shopping/dishes/${slugs.r1}`); // «убрать блюдо» у B не задевает A
  await as(B, "delete", "/me/shopping"); // очистка у B не задевает A

  const now = (await as(A, "get", "/me/shopping")).body.items;
  assert.equal(now.length, items.length);
  assert.equal(now.find((i) => i.name === "Мука").checked, false);
  assert.equal(now.find((i) => i.name === "Мука").contribs.length, 2);
});

test("ИЗОЛЯЦИЯ покупок: у разных пользователей одноимённые позиции независимы", async () => {
  await as(B, "post", "/me/shopping/items").send({ items: [{ name: "Мука", amount: "1 кг" }] });
  const a = (await as(A, "get", "/me/shopping")).body.items.find((i) => i.name === "Мука");
  assert.equal(a.contribs.length, 2);
  assert.equal((await as(B, "get", "/me/shopping")).body.items[0].contribs[0].a, "1 кг");
  await as(B, "delete", "/me/shopping");
});

test("покупки: отметка, удаление позиции, некорректный id → 404", async () => {
  const salt = (await as(A, "get", "/me/shopping")).body.items.find((i) => i.name === "Соль");
  const p = await as(A, "patch", `/me/shopping/items/${salt.id}`).send({ checked: true });
  assert.equal(p.status, 200);
  assert.equal(p.body.items.find((i) => i.id === salt.id).checked, true);
  assert.equal((await as(A, "patch", `/me/shopping/items/${salt.id}`).send({ checked: "да" })).status, 422);

  assert.equal((await as(A, "delete", `/me/shopping/items/${salt.id}`)).status, 204);
  assert.equal((await as(A, "delete", `/me/shopping/items/${salt.id}`)).status, 404);
  assert.equal((await as(A, "delete", "/me/shopping/items/not-a-uuid")).status, 404);
});

test("покупки: «убрать блюдо» ужимает общую позицию, позиции без вкладов пропадают", async () => {
  const r = await as(A, "delete", `/me/shopping/dishes/${slugs.r1}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((i) => [i.name, i.contribs]), [["Мука", [{ r: slugs.r2, a: "2 ст.л." }]]]);

  assert.equal((await as(A, "delete", "/me/shopping")).status, 204);
  assert.deepEqual((await as(A, "get", "/me/shopping")).body.items, []);
});

// ---------- синхронизация ----------

test("sync: валидация (неизвестный тип, плохое время, >200 операций) → 422; огромное тело → 413", async () => {
  const bad = (ops) => as(A, "post", "/me/sync").send({ ops });
  assert.equal((await bad([{ type: "boom", at: ago(1) }])).status, 422);
  assert.equal((await bad([{ type: "favorite.add", slug: slugs.r1, at: "вчера" }])).status, 422);
  const many = Array.from({ length: 201 }, () => ({ type: "shopping.clear", at: ago(1) }));
  assert.equal((await bad(many)).status, 422);
  const big = await as(A, "post", "/me/sync").send({ ops: [], pad: "x".repeat(200 * 1024) });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, "PAYLOAD_TOO_LARGE");
});

test("sync: пачка операций применяется по времени действия, ответ — актуальное состояние", async () => {
  const r = await as(A, "post", "/me/sync").send({
    ops: [
      // порядок в массиве намеренно перепутан: решает at
      { type: "favorite.remove", slug: slugs.r1, at: ago(3000) },
      { type: "favorite.add", slug: slugs.r1, at: ago(5000) },
      { type: "favorite.add", slug: slugs.r2, at: ago(4000) },
      { type: "shopping.add", name: "Молоко", amount: "1 л", recipe: slugs.r1, at: ago(2000) },
      { type: "shopping.add", name: "молоко", amount: "200 мл", recipe: slugs.r2, at: ago(1900) },
      { type: "shopping.check", name: "Молоко", checked: true, at: ago(1800) },
      { type: "note.set", slug: slugs.r1, text: "из офлайна", at: ago(1000) },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.applied, 7);
  assert.deepEqual(r.body.skipped, []);
  assert.deepEqual(r.body.favorites.map((f) => f.slug), [slugs.r2]); // r1: add, затем remove
  assert.equal(r.body.shopping.length, 1);
  assert.equal(r.body.shopping[0].checked, true);
  assert.deepEqual(r.body.shopping[0].contribs, [{ r: slugs.r1, a: "1 л" }, { r: slugs.r2, a: "200 мл" }]);
  assert.equal(r.body.notes[0].text, "из офлайна");
});

test("sync: повторная отправка той же пачки идемпотентна", async () => {
  const ops = [
    { type: "favorite.add", slug: slugs.r1, at: ago(900) },
    { type: "shopping.add", name: "Молоко", amount: "1 л", recipe: slugs.r1, at: ago(800) },
  ];
  await as(A, "post", "/me/sync").send({ ops });
  const r = await as(A, "post", "/me/sync").send({ ops });
  assert.equal(r.body.shopping[0].contribs.length, 2);
  assert.equal(r.body.favorites.length, 2);
});

test("sync: last-write-wins для заметок — устаревшая правка пропускается (STALE), новая применяется", async () => {
  const send = (op) => as(A, "post", "/me/sync").send({ ops: [op] });
  await send({ type: "note.set", slug: slugs.r2, text: "новая", at: ago(1000) });

  let r = await send({ type: "note.set", slug: slugs.r2, text: "старая", at: ago(60000) });
  assert.deepEqual(r.body.skipped, [{ index: 0, type: "note.set", reason: "STALE" }]);
  assert.equal(r.body.notes.find((n) => n.slug === slugs.r2).text, "новая");

  r = await send({ type: "note.remove", slug: slugs.r2, at: ago(60000) });
  assert.equal(r.body.skipped[0].reason, "STALE");
  assert.ok(r.body.notes.some((n) => n.slug === slugs.r2));

  r = await send({ type: "note.set", slug: slugs.r2, text: "ещё новее", at: ago(10) });
  assert.equal(r.body.skipped.length, 0);
  assert.equal(r.body.notes.find((n) => n.slug === slugs.r2).text, "ещё новее");

  r = await send({ type: "note.remove", slug: slugs.r2, at: ago(5) });
  assert.ok(!r.body.notes.some((n) => n.slug === slugs.r2));
});

test("sync: время из будущего обрезается до серверного и не блокирует последующие правки", async () => {
  const future = new Date(Date.now() + 365 * 86400e3).toISOString();
  await as(A, "post", "/me/sync").send({ ops: [{ type: "note.set", slug: slugs.r1, text: "из будущего", at: future }] });
  const r = await as(A, "post", "/me/sync").send({
    ops: [{ type: "note.set", slug: slugs.r1, text: "обычная правка", at: new Date(Date.now() + 2000).toISOString() }],
  });
  assert.equal(r.body.notes.find((n) => n.slug === slugs.r1).text, "обычная правка");
});

test("sync: неизвестные/черновые рецепты пропускаются с индексом, остальное применяется", async () => {
  const r = await as(A, "post", "/me/sync").send({
    ops: [
      { type: "favorite.add", slug: "net-takogo", at: ago(300) },
      { type: "favorite.add", slug: slugs.draft, at: ago(200) },
      { type: "shopping.add", name: "Сыр", recipe: "net-takogo", at: ago(100) },
      { type: "shopping.add", name: "Сыр", at: ago(50) },
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.skipped.map((s) => [s.index, s.reason]), [[0, "NOT_FOUND"], [1, "NOT_FOUND"], [2, "NOT_FOUND"]]);
  assert.equal(r.body.applied, 1);
  assert.ok(r.body.shopping.some((i) => i.name === "Сыр"));
});

test("sync: removeDish и clear", async () => {
  let r = await as(A, "post", "/me/sync").send({ ops: [{ type: "shopping.removeDish", slug: slugs.r1, at: ago(10) }] });
  const milk = r.body.shopping.find((i) => i.name === "Молоко");
  assert.deepEqual(milk.contribs.map((c) => c.r), [slugs.r2]);
  r = await as(A, "post", "/me/sync").send({ ops: [{ type: "shopping.clear", at: ago(5) }] });
  assert.deepEqual(r.body.shopping, []);
});

test("ИЗОЛЯЦИЯ sync: операции и ответ касаются только данных вызвавшего", async () => {
  const favs = (await as(A, "get", "/me/favorites")).body;
  const notes = (await as(A, "get", "/me/notes")).body;
  assert.ok(favs.items.length > 0 && notes.items.length > 0, "у A есть что терять");

  const r = await as(B, "post", "/me/sync").send({
    ops: [
      { type: "favorite.remove", slug: slugs.r1, at: ago(20) },
      { type: "note.remove", slug: slugs.r1, at: ago(20) },
      { type: "shopping.clear", at: ago(20) },
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.favorites, []); // в ответе B нет данных A
  assert.deepEqual(r.body.notes, []);
  assert.deepEqual(r.body.shopping, []);
  assert.deepEqual((await as(A, "get", "/me/favorites")).body, favs);
  assert.deepEqual((await as(A, "get", "/me/notes")).body, notes);
});

test("sync: транзакция атомарна — сбой посреди пачки откатывает уже применённые операции", async () => {
  await as(A, "delete", `/me/favorites/${slugs.r2}`); // исходное состояние: r2 не в избранном
  const original = shoppingService.addEntry;
  shoppingService.addEntry = async () => {
    throw new Error("boom");
  };
  try {
    const r = await as(A, "post", "/me/sync").send({
      ops: [
        { type: "favorite.add", slug: slugs.r2, at: ago(30) }, // применится первой…
        { type: "shopping.add", name: "Атом", at: ago(20) }, // …затем сбой
      ],
    });
    assert.equal(r.status, 500);
  } finally {
    shoppingService.addEntry = original;
  }
  const favs = (await as(A, "get", "/me/favorites")).body.items.map((f) => f.slug);
  assert.ok(!favs.includes(slugs.r2), "favorite.add из откатанной пачки не должно остаться");
});
