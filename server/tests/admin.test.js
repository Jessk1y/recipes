// Интеграционные тесты admin: доступ только админу, смена роли, блокировка, правило LAST_ADMIN.
// Правило «последний админ» считает всех администраторов в БД, поэтому тесты идут в отдельной
// схеме Postgres (recipes_test) — рабочие данные и настоящие админы не затрагиваются.
const { execSync } = require("node:child_process");
const path = require("node:path");

require("dotenv").config();
const testUrl = new URL(process.env.DATABASE_URL);
testUrl.searchParams.set("schema", "recipes_test");
process.env.DATABASE_URL = testUrl.toString(); // dotenv не перезаписывает уже заданные переменные
process.env.NODE_ENV = "test";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcrypt");

const root = path.join(__dirname, "..");
execSync(`node node_modules/prisma/build/index.js migrate deploy`, { cwd: root, stdio: "pipe" });

const app = require("../src/app");
const prisma = require("../src/lib/prisma");

const PASSWORD = "test-password-1";
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const as = (token, m, url) => api(m, url).set("Authorization", `Bearer ${token}`);
const email = (name) => `${name}@admin-test.example.com`;

let hash;
const users = {}; // имя → { id, token }

async function createUser(name, { role = "USER", isBlocked = false } = {}) {
  const u = await prisma.user.create({
    data: { email: email(name), passwordHash: hash, displayName: name, role, isBlocked },
  });
  users[name] = { id: u.id };
  return u;
}
async function loginAs(name) {
  const r = await api("post", "/auth/login").send({ email: email(name), password: PASSWORD });
  assert.equal(r.status, 200, `login ${name}`);
  users[name].token = r.body.accessToken;
  users[name].refresh = r.body.refreshToken;
}
const state = (name) => prisma.user.findUnique({ where: { id: users[name].id }, select: { role: true, isBlocked: true } });
const setRole = (actor, target, role) =>
  as(users[actor].token, "patch", `/admin/users/${users[target].id}/role`).send({ role });
const setBlocked = (actor, target, blocked) =>
  as(users[actor].token, "patch", `/admin/users/${users[target].id}/block`).send({ blocked });
const activeAdmins = () => prisma.user.count({ where: { role: "ADMIN", isBlocked: false } });

async function resetUsers() {
  await prisma.user.deleteMany({});
  for (const k of Object.keys(users)) delete users[k];
}

before(async () => {
  hash = await bcrypt.hash(PASSWORD, 4);
  await resetUsers();
});

after(async () => {
  await resetUsers();
  await prisma.$disconnect();
});

// ---------- доступ ----------

test("все эндпоинты admin: без токена и с мусорным токеном 401, обычному пользователю 403", async () => {
  await resetUsers();
  await createUser("plain");
  await createUser("boss", { role: "ADMIN" });
  await loginAs("plain");
  const id = users.boss.id;
  const routes = [
    ["get", "/admin/users", undefined],
    ["patch", `/admin/users/${id}/role`, { role: "USER" }],
    ["patch", `/admin/users/${id}/block`, { blocked: true }],
  ];
  for (const [m, url, body] of routes) {
    assert.equal((await api(m, url).send(body)).status, 401, `${m} ${url} без токена`);
    assert.equal((await api(m, url).set("Authorization", "Bearer junk").send(body)).status, 401, `${m} ${url} мусор`);
    const r = await as(users.plain.token, m, url).send(body);
    assert.equal(r.status, 403, `${m} ${url} обычный пользователь`);
    assert.equal(r.body.error.code, "FORBIDDEN");
  }
  assert.deepEqual(await state("boss"), { role: "ADMIN", isBlocked: false }, "403 ничего не изменил");
});

test("токен с подделанной ролью ADMIN не даёт доступа (роль берётся из БД)", async () => {
  const jwt = require("jsonwebtoken");
  const env = require("../src/config/env");
  const forged = jwt.sign({ sub: users.plain.id, role: "ADMIN" }, env.JWT_SECRET, { expiresIn: "5m" });
  // даже корректно подписанный токен с role=ADMIN у обычного пользователя отвергается
  assert.equal((await as(forged, "get", "/admin/users")).status, 403);
});

// ---------- список ----------

test("GET /admin/users: список без хешей паролей, фильтры и пагинация", async () => {
  await resetUsers();
  await createUser("boss", { role: "ADMIN" });
  await createUser("anna");
  await createUser("boris", { isBlocked: true });
  await loginAs("boss");

  const all = await as(users.boss.token, "get", "/admin/users");
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 3);
  assert.equal(JSON.stringify(all.body).includes("passwordHash"), false);
  assert.deepEqual(Object.keys(all.body.items[0]).sort(), ["createdAt", "displayName", "email", "id", "isBlocked", "role"]);

  const byRole = await as(users.boss.token, "get", "/admin/users?role=ADMIN");
  assert.deepEqual(byRole.body.items.map((u) => u.displayName), ["boss"]);

  const blocked = await as(users.boss.token, "get", "/admin/users?blocked=true");
  assert.deepEqual(blocked.body.items.map((u) => u.displayName), ["boris"]);
  const notBlocked = await as(users.boss.token, "get", "/admin/users?blocked=false");
  assert.equal(notBlocked.body.total, 2);

  const search = await as(users.boss.token, "get", "/admin/users?q=ANN");
  assert.deepEqual(search.body.items.map((u) => u.displayName), ["anna"]);

  const p1 = await as(users.boss.token, "get", "/admin/users?limit=2&page=1");
  const p2 = await as(users.boss.token, "get", "/admin/users?limit=2&page=2");
  assert.equal(p1.body.items.length, 2);
  assert.equal(p2.body.items.length, 1);
  assert.equal(p1.body.total, 3);
  const ids = [...p1.body.items, ...p2.body.items].map((u) => u.id);
  assert.equal(new Set(ids).size, 3, "страницы не пересекаются");
});

test("GET /admin/users: некорректные параметры → 422", async () => {
  for (const q of ["limit=0", "limit=101", "page=0", "role=GOD", "blocked=maybe"]) {
    const r = await as(users.boss.token, "get", `/admin/users?${q}`);
    assert.equal(r.status, 422, q);
    assert.equal(r.body.error.code, "VALIDATION_ERROR");
  }
});

// ---------- роль ----------

test("PATCH role: валидация и 404", async () => {
  const bad = await setRole("boss", "anna", "GOD");
  assert.equal(bad.status, 422);
  const noBody = await as(users.boss.token, "patch", `/admin/users/${users.anna.id}/role`).send({});
  assert.equal(noBody.status, 422);
  const badId = await as(users.boss.token, "patch", "/admin/users/not-a-uuid/role").send({ role: "USER" });
  assert.equal(badId.status, 422);
  const missing = await as(users.boss.token, "patch", "/admin/users/11111111-1111-4111-8111-111111111111/role").send({ role: "USER" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "NOT_FOUND");
});

test("PATCH role: повышение и понижение; новый админ сразу получает доступ", async () => {
  const up = await setRole("boss", "anna", "ADMIN");
  assert.equal(up.status, 200);
  assert.equal(up.body.role, "ADMIN");
  assert.equal(JSON.stringify(up.body).includes("passwordHash"), false);

  await loginAs("anna"); // новый токен уже с ролью ADMIN
  assert.equal((await as(users.anna.token, "get", "/admin/users")).status, 200);

  const down = await setRole("boss", "anna", "USER");
  assert.equal(down.status, 200);
  assert.equal(down.body.role, "USER");
});

test("разжалованный админ теряет доступ сразу, не дожидаясь истечения старого JWT", async () => {
  await setRole("boss", "anna", "ADMIN");
  await loginAs("anna");
  assert.equal((await as(users.anna.token, "get", "/admin/users")).status, 200);
  await setRole("boss", "anna", "USER");
  const r = await as(users.anna.token, "get", "/admin/users"); // токен ещё с role=ADMIN
  assert.equal(r.status, 403);
});

// ---------- LAST_ADMIN ----------

// Гонка двух админов: ровно один запрос проходит. Проигравший получает либо 409 LAST_ADMIN (его проверила
// транзакция), либо 403 (его права уже сняты к моменту проверки guard) — оба исхода корректны.
function oneWins(r1, r2, i) {
  const statuses = [r1.status, r2.status];
  assert.equal(statuses.filter((s) => s === 200).length, 1, `попытка ${i}: ${statuses}`);
  const loser = r1.status === 200 ? r2 : r1;
  assert.ok([403, 409].includes(loser.status), `попытка ${i}: проигравший ${loser.status}`);
}

test("LAST_ADMIN: единственного админа нельзя ни разжаловать, ни заблокировать", async () => {
  await resetUsers();
  await createUser("solo", { role: "ADMIN" });
  await createUser("plain");
  await loginAs("solo");

  const demote = await setRole("solo", "solo", "USER");
  assert.equal(demote.status, 409);
  assert.equal(demote.body.error.code, "LAST_ADMIN");
  const block = await setBlocked("solo", "solo", true);
  assert.equal(block.status, 409);
  assert.equal(block.body.error.code, "LAST_ADMIN");
  assert.deepEqual(await state("solo"), { role: "ADMIN", isBlocked: false });

  // подтверждение «без изменений» не должно ломаться: ADMIN → ADMIN и unblock — не ограничения
  assert.equal((await setRole("solo", "solo", "ADMIN")).status, 200);
  assert.equal((await setBlocked("solo", "solo", false)).status, 200);
  // и обычного пользователя можно блокировать/менять свободно
  assert.equal((await setBlocked("solo", "plain", true)).status, 200);
});

test("LAST_ADMIN: при двух админах один может разжаловать другого, но не себя после этого", async () => {
  await resetUsers();
  await createUser("a1", { role: "ADMIN" });
  await createUser("a2", { role: "ADMIN" });
  await loginAs("a1");
  await loginAs("a2");

  assert.equal((await setRole("a1", "a2", "USER")).status, 200);
  assert.equal(await activeAdmins(), 1);
  const self = await setRole("a1", "a1", "USER");
  assert.equal(self.status, 409);
  assert.equal(self.body.error.code, "LAST_ADMIN");
  assert.equal(await activeAdmins(), 1);
});

test("LAST_ADMIN: заблокированный админ не считается активным", async () => {
  await resetUsers();
  await createUser("a1", { role: "ADMIN" });
  await createUser("a2", { role: "ADMIN" });
  await loginAs("a1");

  assert.equal((await setBlocked("a1", "a2", true)).status, 200); // a2 заблокирован
  // теперь a1 — единственный активный, хотя в БД два ADMIN
  assert.equal((await setRole("a1", "a1", "USER")).status, 409);
  assert.equal((await setBlocked("a1", "a1", true)).status, 409);
  // разблокировка возвращает второго админа в строй — тогда a1 можно разжаловать
  assert.equal((await setBlocked("a1", "a2", false)).status, 200);
  assert.equal((await setRole("a1", "a1", "USER")).status, 200);
  assert.equal(await activeAdmins(), 1);
});

test("LAST_ADMIN: два админа одновременно лишают друг друга прав — выживает хотя бы один", async () => {
  for (let i = 0; i < 5; i++) {
    await resetUsers();
    await createUser("a1", { role: "ADMIN" });
    await createUser("a2", { role: "ADMIN" });
    await loginAs("a1");
    await loginAs("a2");
    const [r1, r2] = await Promise.all([setRole("a1", "a2", "USER"), setRole("a2", "a1", "USER")]);
    oneWins(r1, r2, i);
    assert.equal(await activeAdmins(), 1, `попытка ${i}`);
  }
});

test("LAST_ADMIN: то же при одновременной блокировке друг друга", async () => {
  for (let i = 0; i < 5; i++) {
    await resetUsers();
    await createUser("a1", { role: "ADMIN" });
    await createUser("a2", { role: "ADMIN" });
    await loginAs("a1");
    await loginAs("a2");
    const [r1, r2] = await Promise.all([setBlocked("a1", "a2", true), setBlocked("a2", "a1", true)]);
    oneWins(r1, r2, i);
    assert.equal(await activeAdmins(), 1, `попытка ${i}`);
  }
});

// ---------- блокировка ----------

test("блокировка: не может войти и обновить токен; refresh-токены отозваны; разблокировка возвращает доступ", async () => {
  await resetUsers();
  await createUser("boss", { role: "ADMIN" });
  await createUser("victim");
  await loginAs("boss");
  await loginAs("victim");
  const oldRefresh = users.victim.refresh;

  const r = await setBlocked("boss", "victim", true);
  assert.equal(r.status, 200);
  assert.equal(r.body.isBlocked, true);

  const login = await api("post", "/auth/login").send({ email: email("victim"), password: PASSWORD });
  assert.equal(login.status, 403);
  assert.equal(login.body.error.code, "ACCOUNT_BLOCKED");

  const refresh = await api("post", "/auth/refresh").send({ refreshToken: oldRefresh });
  assert.equal(refresh.status, 401, "токен уже отозван при блокировке");
  const live = await prisma.refreshToken.count({ where: { userId: users.victim.id, revokedAt: null } });
  assert.equal(live, 0, "живых refresh-токенов нет");

  // неверный пароль заблокированному по-прежнему 401, а не 403 — блокировка не раскрывается без пароля
  const wrong = await api("post", "/auth/login").send({ email: email("victim"), password: "wrong-password" });
  assert.equal(wrong.status, 401);

  const unblock = await setBlocked("boss", "victim", false);
  assert.equal(unblock.status, 200);
  assert.equal(unblock.body.isBlocked, false);
  assert.equal((await api("post", "/auth/login").send({ email: email("victim"), password: PASSWORD })).status, 200);
});

test("блокировка: refresh-токен, выданный до блокировки и не отозванный, всё равно не обновляется", async () => {
  // эмулируем «токен остался живым» (например, блокировка прошла напрямую в БД)
  await resetUsers();
  await createUser("victim");
  await loginAs("victim");
  await prisma.user.update({ where: { id: users.victim.id }, data: { isBlocked: true } });
  const r = await api("post", "/auth/refresh").send({ refreshToken: users.victim.refresh });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "ACCOUNT_BLOCKED");
});

test("заблокированный админ теряет доступ к админке сразу (старый JWT)", async () => {
  await resetUsers();
  await createUser("a1", { role: "ADMIN" });
  await createUser("a2", { role: "ADMIN" });
  await loginAs("a1");
  await loginAs("a2");
  assert.equal((await as(users.a2.token, "get", "/admin/users")).status, 200);
  assert.equal((await setBlocked("a1", "a2", true)).status, 200);
  const r = await as(users.a2.token, "get", "/admin/users");
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "ACCOUNT_BLOCKED");
});

test("блокировка и смена роли идемпотентны: повтор не ломается и ничего не меняет", async () => {
  await resetUsers();
  await createUser("boss", { role: "ADMIN" });
  await createUser("victim");
  await loginAs("boss");
  const a = await setBlocked("boss", "victim", true);
  const b = await setBlocked("boss", "victim", true);
  assert.equal(b.status, 200);
  assert.deepEqual(a.body, b.body);
  const c = await setRole("boss", "victim", "USER");
  assert.equal(c.status, 200);
  assert.equal(c.body.role, "USER");
});

// ---------- запись рецептов и загрузка фото: права действуют сразу ----------

const recipeBody = (title) => ({
  title,
  category: "Тест-категория",
  ingredients: [{ name: "Соль" }],
  steps: [{ text: "Посолить" }],
});
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

test("разжалованный админ: старый токен даёт 403 на POST /recipes и загрузке фото", async () => {
  await resetUsers();
  await createUser("a1", { role: "ADMIN" });
  await createUser("a2", { role: "ADMIN" });
  await loginAs("a1");
  await loginAs("a2");

  // пока админ — запись работает
  const created = await as(users.a2.token, "post", "/recipes").send(recipeBody("Рецепт до разжалования"));
  assert.equal(created.status, 201);

  assert.equal((await setRole("a1", "a2", "USER")).status, 200);

  // токен a2 всё ещё подписан с role=ADMIN, но права проверяются по БД
  const post = await as(users.a2.token, "post", "/recipes").send(recipeBody("Рецепт после разжалования"));
  assert.equal(post.status, 403);
  assert.equal(post.body.error.code, "FORBIDDEN");
  const put = await as(users.a2.token, "put", `/recipes/${created.body.id}`).send(recipeBody("Правка"));
  assert.equal(put.status, 403);
  assert.equal((await as(users.a2.token, "patch", `/recipes/${created.body.id}/status`).send({ status: "PUBLISHED" })).status, 403);
  assert.equal((await as(users.a2.token, "delete", `/recipes/${created.body.id}`)).status, 403);
  const upload = await as(users.a2.token, "post", "/uploads/image").attach("file", png, "x.png");
  assert.equal(upload.status, 403);

  assert.equal(await prisma.recipe.count({ where: { title: "Рецепт после разжалования" } }), 0, "рецепт не создан");
  assert.equal((await prisma.recipe.findUnique({ where: { id: created.body.id } })).title, "Рецепт до разжалования", "рецепт не изменён");
  await prisma.recipe.deleteMany({});
});

test("заблокированный админ: старый токен даёт 403 ACCOUNT_BLOCKED на POST /recipes и загрузке фото", async () => {
  await resetUsers();
  await createUser("a1", { role: "ADMIN" });
  await createUser("a2", { role: "ADMIN" });
  await loginAs("a1");
  await loginAs("a2");
  assert.equal((await setBlocked("a1", "a2", true)).status, 200);

  const post = await as(users.a2.token, "post", "/recipes").send(recipeBody("Рецепт от заблокированного"));
  assert.equal(post.status, 403);
  assert.equal(post.body.error.code, "ACCOUNT_BLOCKED");
  const upload = await as(users.a2.token, "post", "/uploads/image").attach("file", png, "x.png");
  assert.equal(upload.status, 403);
  assert.equal(await prisma.recipe.count(), 0);
});

test("действующий админ по-прежнему пишет рецепты и загружает фото", async () => {
  await resetUsers();
  await createUser("a1", { role: "ADMIN" });
  await loginAs("a1");
  const post = await as(users.a1.token, "post", "/recipes").send(recipeBody("Рецепт админа"));
  assert.equal(post.status, 201);
  const upload = await as(users.a1.token, "post", "/uploads/image").attach("file", png, "x.png");
  assert.equal(upload.status, 201);
  await prisma.recipe.deleteMany({});
  const fs = require("node:fs");
  const storage = require("../src/lib/storage");
  await storage.remove(upload.body.publicId).catch(() => {});
});
