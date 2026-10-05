// Интеграционные тесты API рецептов и загрузки изображений. Нужна БД из DATABASE_URL.
process.env.NODE_ENV = "test";
process.env.STORAGE_DRIVER = "local"; // тесты не должны ходить в настоящий Cloudinary, даже если ключ есть в .env
const fs = require("fs");
const path = require("path");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcrypt");
const app = require("../src/app");
const prisma = require("../src/lib/prisma");
const { UPLOAD_DIR } = require("../src/lib/storage");

const T = `zz${Date.now().toString(36)}`; // уникальная метка, чтобы не пересекаться с реальными данными
const CATEGORY = `Тест ${T}`;
const TAG = `тег-${T}`;
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const as = (token, m, url) => api(m, url).set("Authorization", `Bearer ${token}`);
const emails = { admin: `admin-${T}@example.com`, user: `user-${T}@example.com` };
const PASSWORD = "test-password-1";
let adminToken, userToken, recipe;
const uploaded = [];

const input = (over = {}) => ({
  title: `Тестовый пирог ${T}`,
  category: CATEGORY,
  main: ["Десерт", "Шоколад"],
  tags: [TAG, "Десерт"],
  image: "images/test.jpg",
  time: "1 ч 10 мин",
  servings: "6 порций",
  ingredients: [{ kind: "HEADER", name: "Тесто", amount: "игнор" }, { name: "Мука", amount: "200 г" }, { name: "Яйца" }],
  steps: [{ kind: "HEADER", text: "Подготовка" }, { text: "Выпекать 25 мин при 180°C." }, { text: "Остудить." }],
  status: "DRAFT",
  ...over,
});

async function login(email) {
  const r = await api("post", "/auth/login").send({ email, password: PASSWORD });
  return r.body.accessToken;
}

before(async () => {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  await prisma.user.create({ data: { email: emails.admin, passwordHash, displayName: "A", role: "ADMIN" } });
  await prisma.user.create({ data: { email: emails.user, passwordHash, displayName: "U" } });
  adminToken = await login(emails.admin);
  userToken = await login(emails.user);
});

after(async () => {
  await prisma.recipe.deleteMany({ where: { title: { contains: T } } });
  await prisma.category.deleteMany({ where: { name: { contains: T } } });
  await prisma.tag.deleteMany({ where: { name: { contains: T } } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  for (const f of uploaded) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
  await prisma.$disconnect();
});

// ---------- права и валидация ----------

test("создание: гость 401, обычный пользователь 403", async () => {
  assert.equal((await api("post", "/recipes").send(input())).status, 401);
  assert.equal((await as(userToken, "post", "/recipes").send(input())).status, 403);
});

test("создание: валидация Zod → 422 с деталями", async () => {
  const bad = [
    input({ title: "" }),
    input({ ingredients: [] }),
    input({ steps: [{ kind: "HEADER", text: "Только заголовок" }] }),
    input({ main: ["Выдуманный тег"] }),
    input({ image: "javascript:alert(1)" }),
    input({ slug: "Плохой Slug" }),
  ];
  for (const body of bad) {
    const r = await as(adminToken, "post", "/recipes").send(body);
    assert.equal(r.status, 422, JSON.stringify(body).slice(0, 80));
    assert.equal(r.body.error.code, "VALIDATION_ERROR");
    assert.ok(r.body.error.details.length > 0);
  }
});

// ---------- создание и черновики ----------

test("создание: 201, slug из названия, время и таймеры вычислены, подзаголовки без количества", async () => {
  const r = await as(adminToken, "post", "/recipes").send(input());
  assert.equal(r.status, 201);
  recipe = r.body;
  assert.match(recipe.slug, new RegExp(`^testovyy-pirog-${T}$`));
  assert.equal(recipe.status, "DRAFT");
  assert.equal(recipe.timeMinutes, 70);
  assert.deepEqual(recipe.main, ["Десерт", "Шоколад"]);
  assert.deepEqual(recipe.tags, [TAG]); // «Десерт» среди свободных тегов не дублируется
  assert.equal(recipe.ingredients[0].amount, null);
  assert.deepEqual(recipe.ingredients.map((i) => i.name), ["Тесто", "Мука", "Яйца"]);
  assert.equal(recipe.steps[0].timerSeconds, null);
  assert.equal(recipe.steps[1].timerSeconds, 25 * 60);
  assert.equal(recipe.steps[2].timerSeconds, null);
});

test("создание: тот же title → slug с суффиксом; явный занятый slug → 409", async () => {
  const dup = await as(adminToken, "post", "/recipes").send(input());
  assert.equal(dup.status, 201);
  assert.equal(dup.body.slug, `${recipe.slug}-2`);
  const clash = await as(adminToken, "post", "/recipes").send(input({ slug: recipe.slug }));
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, "SLUG_TAKEN");
  await as(adminToken, "delete", `/recipes/${dup.body.id}`);
});

test("черновик скрыт от гостей и пользователей, виден админу", async () => {
  assert.equal((await api("get", `/recipes/${recipe.slug}`)).status, 404);
  assert.equal((await as(userToken, "get", `/recipes/${recipe.slug}`)).status, 404);
  assert.equal((await as(adminToken, "get", `/recipes/${recipe.slug}`)).status, 200);

  const guestList = await api("get", `/recipes?q=${T}`);
  assert.equal(guestList.body.total, 0);
  assert.equal((await api("get", "/recipes?status=DRAFT")).status, 403);
  const adminList = await as(adminToken, "get", `/recipes?q=${T}&status=all`);
  assert.equal(adminList.body.total, 1);
});

test("PATCH status: публикация делает рецепт публичным; неверный статус → 422", async () => {
  assert.equal((await as(adminToken, "patch", `/recipes/${recipe.id}/status`).send({ status: "X" })).status, 422);
  assert.equal((await as(userToken, "patch", `/recipes/${recipe.id}/status`).send({ status: "PUBLISHED" })).status, 403);
  const r = await as(adminToken, "patch", `/recipes/${recipe.id}/status`).send({ status: "PUBLISHED" });
  assert.deepEqual(r.body, { id: recipe.id, status: "PUBLISHED" });
  assert.equal((await api("get", `/recipes/${recipe.slug}`)).status, 200);
});

// ---------- чтение ----------

test("список: поиск по названию, ингредиенту и тегу (без учёта регистра)", async () => {
  for (const q of [T.toUpperCase(), "мука", TAG]) {
    const r = await api("get", `/recipes?q=${encodeURIComponent(q)}`);
    assert.ok(r.body.items.some((i) => i.id === recipe.id), `q=${q}`);
  }
  assert.equal((await api("get", `/recipes?q=${T}-нет-такого`)).body.total, 0);
});

test("список: фильтры main / category / maxTime и форма карточки", async () => {
  const base = `/recipes?q=${T}`;
  assert.equal((await api("get", `${base}&main=Десерт,Шоколад`)).body.total, 1);
  assert.equal((await api("get", `${base}&main=Курица`)).body.total, 0);
  assert.equal((await api("get", `${base}&maxTime=60`)).body.total, 0);
  assert.equal((await api("get", `${base}&maxTime=70`)).body.total, 1);
  const slug = (await api("get", "/categories")).body.find((c) => c.name === CATEGORY).slug;
  const r = await api("get", `${base}&category=${slug}`);
  assert.equal(r.body.total, 1);
  const card = r.body.items[0];
  assert.equal(card.category.name, CATEGORY);
  assert.equal(card.ingredients, undefined); // карточка без ингредиентов и шагов
});

test("список: пагинация и валидация query", async () => {
  const r = await api("get", "/recipes?limit=5&page=2&sort=title");
  assert.equal(r.status, 200);
  assert.equal(r.body.page, 2);
  assert.equal(r.body.limit, 5);
  assert.ok(r.body.items.length <= 5);
  assert.equal((await api("get", "/recipes?limit=100")).status, 422);
  assert.equal((await api("get", "/recipes?sort=foo")).status, 422);
});

test("рецепт: полный состав, ETag → 304, неизвестный slug 404", async () => {
  const r = await api("get", `/recipes/${recipe.slug}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.steps.length, 3);
  const etag = r.headers.etag;
  assert.ok(etag);
  assert.equal((await api("get", `/recipes/${recipe.slug}`).set("If-None-Match", etag)).status, 304);
  assert.equal((await api("get", "/recipes/net-takogo")).status, 404);
});

test("random: возвращает slug по фильтру; пустая выборка → 404", async () => {
  const r = await api("get", "/recipes/random?main=Шоколад");
  assert.equal(r.status, 200);
  assert.ok(r.body.slug);
  assert.equal((await api("get", "/recipes/random?main=Выдуманный")).status, 404);
});

test("categories и tags", async () => {
  const cats = (await api("get", "/categories")).body;
  assert.equal(cats.find((c) => c.name === CATEGORY).count, 1);
  const main = (await api("get", "/tags?main=true")).body;
  assert.ok(main.length > 0 && main.every((t) => t.isMain));
  assert.ok((await api("get", "/tags")).body.some((t) => t.name === TAG && !t.isMain));
});

test("snapshot: ETag, 304 при той же версии, версия меняется после правки", async () => {
  const a = await api("get", "/catalog/snapshot");
  assert.equal(a.status, 200);
  assert.ok(a.body.recipes.some((r) => r.id === recipe.id));
  assert.ok(a.body.recipes[0].ingredients);
  const same = await api("get", "/catalog/snapshot").set("If-None-Match", a.headers.etag);
  assert.equal(same.status, 304);

  await new Promise((r) => setTimeout(r, 5));
  await as(adminToken, "put", `/recipes/${recipe.id}`).send(input({ status: "PUBLISHED" }));
  const after = await api("get", "/catalog/snapshot").set("If-None-Match", a.headers.etag);
  assert.equal(after.status, 200);
  assert.notEqual(after.body.version, a.body.version);
});

// ---------- правка и удаление ----------

test("PUT: полная замена состава, slug сохраняется; 404 для неизвестного id", async () => {
  const body = input({
    title: `Тестовый пирог ${T} (новый)`,
    main: ["Второе"],
    tags: [],
    ingredients: [{ name: "Картофель", amount: "1 кг" }],
    steps: [{ text: "Варить 1,5 ч.", timerSeconds: 600 }],
    status: "PUBLISHED",
  });
  const r = await as(adminToken, "put", `/recipes/${recipe.id}`).send(body);
  assert.equal(r.status, 200);
  assert.equal(r.body.slug, recipe.slug);
  assert.deepEqual(r.body.main, ["Второе"]);
  assert.deepEqual(r.body.ingredients, [{ kind: "ITEM", name: "Картофель", amount: "1 кг" }]);
  assert.equal(r.body.steps[0].timerSeconds, 600); // явное значение важнее разбора текста
  assert.equal((await as(userToken, "put", `/recipes/${recipe.id}`).send(body)).status, 403);
  const missing = "00000000-0000-4000-8000-000000000000";
  assert.equal((await as(adminToken, "put", `/recipes/${missing}`).send(body)).status, 404);
  assert.equal((await as(adminToken, "put", "/recipes/not-a-uuid").send(body)).status, 404);
});

test("загрузка фото (заглушка): права, тип по сигнатуре, размер, раздача файла", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  assert.equal((await api("post", "/uploads/image").attach("file", png, "a.png")).status, 401);
  assert.equal((await as(userToken, "post", "/uploads/image").attach("file", png, "a.png")).status, 403);
  assert.equal((await as(adminToken, "post", "/uploads/image")).status, 422);

  // расширение .png, но содержимое — текст
  const fake = await as(adminToken, "post", "/uploads/image").attach("file", Buffer.from("not an image at all"), "a.png");
  assert.equal(fake.status, 415);
  const big = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);
  assert.equal((await as(adminToken, "post", "/uploads/image").attach("file", big, "big.png")).status, 413);

  const ok = await as(adminToken, "post", "/uploads/image").attach("file", png, "a.png");
  assert.equal(ok.status, 201);
  uploaded.push(ok.body.publicId);
  assert.match(ok.body.url, /\/uploads\/[0-9a-f-]{36}\.png$/);
  const file = await request(app).get(new URL(ok.body.url).pathname);
  assert.equal(file.status, 200);
  assert.equal(file.headers["cross-origin-resource-policy"], "cross-origin");

  // рецепт с этим фото: при удалении файл тоже удаляется
  const r = await as(adminToken, "post", "/recipes").send(input({ title: `Фото ${T}`, image: ok.body.url }));
  assert.equal(r.status, 201);
  await as(adminToken, "delete", `/recipes/${r.body.id}`);
  assert.equal(fs.existsSync(path.join(UPLOAD_DIR, ok.body.publicId)), false);
});

test("PUT: при замене фото старое загруженное файл удаляется, общий — нет", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const up = async () => {
    const r = await as(adminToken, "post", "/uploads/image").attach("file", png, "a.png");
    uploaded.push(r.body.publicId);
    return r.body;
  };
  const exists = (u) => fs.existsSync(path.join(UPLOAD_DIR, u.publicId));
  const [a, b] = [await up(), await up()];

  const r = await as(adminToken, "post", "/recipes").send(input({ title: `Замена фото ${T}`, image: a.url }));
  const other = await as(adminToken, "post", "/recipes").send(input({ title: `Второй с фото ${T}`, image: a.url }));
  assert.equal(r.status, 201);

  // на фото A ещё ссылается другой рецепт — не удаляем
  await as(adminToken, "put", `/recipes/${r.body.id}`).send(input({ title: `Замена фото ${T}`, image: b.url }));
  assert.equal(exists(a), true);
  // теперь ссылок на A нет — удаляем; B (новое) остаётся
  await as(adminToken, "put", `/recipes/${other.body.id}`).send(input({ title: `Второй с фото ${T}`, image: "images/test.jpg" }));
  assert.equal(exists(a), false);
  assert.equal(exists(b), true);
  // тот же URL в PUT — ничего не теряем; сброс фото (null) — удаляет
  await as(adminToken, "put", `/recipes/${r.body.id}`).send(input({ title: `Замена фото ${T}`, image: b.url }));
  assert.equal(exists(b), true);
  await as(adminToken, "put", `/recipes/${r.body.id}`).send(input({ title: `Замена фото ${T}`, image: null }));
  assert.equal(exists(b), false);
});

test("DELETE: права, 204, затем 404", async () => {
  assert.equal((await api("delete", `/recipes/${recipe.id}`)).status, 401);
  assert.equal((await as(userToken, "delete", `/recipes/${recipe.id}`)).status, 403);
  assert.equal((await as(adminToken, "delete", `/recipes/${recipe.id}`)).status, 204);
  assert.equal((await as(adminToken, "delete", `/recipes/${recipe.id}`)).status, 404);
  assert.equal((await api("get", `/recipes/${recipe.slug}`)).status, 404);
});
