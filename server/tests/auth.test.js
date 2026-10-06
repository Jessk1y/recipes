// Интеграционные тесты auth. Нужна работающая БД из DATABASE_URL (лучше отдельная тестовая).
// Запуск: npm test
process.env.NODE_ENV = "test";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../src/app");
const prisma = require("../src/lib/prisma");
const { requireRole } = require("../src/middleware/auth");

const email = `test-${Date.now()}@example.com`;
const password = "correct-horse-1";
const api = (m, url) => request(app)[m](`/api/v1${url}`);
let session;

after(async () => {
  await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

test("health: сервер и БД отвечают", async () => {
  const r = await api("get", "/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: "ok", db: "ok" });
});

test("register: валидация (короткий пароль → 422)", async () => {
  const r = await api("post", "/auth/register").send({ email, password: "123", confirmPassword: "123", displayName: "Т" });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "VALIDATION_ERROR");
});

test("register: успех, роль USER, хеш пароля наружу не отдаётся", async () => {
  const r = await api("post", "/auth/register").send({ email, password, confirmPassword: password, displayName: "Тест" });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, "USER");
  assert.ok(r.body.accessToken && r.body.refreshToken);
  assert.equal(JSON.stringify(r.body).includes("passwordHash"), false);
  session = r.body;
});

test("register: повторный e-mail → 409 EMAIL_TAKEN", async () => {
  const r = await api("post", "/auth/register").send({ email: email.toUpperCase(), password, confirmPassword: password, displayName: "Т" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "EMAIL_TAKEN");
});

test("login: неверный пароль и неизвестный e-mail дают одинаковый ответ", async () => {
  const a = await api("post", "/auth/login").send({ email, password: "wrong-password" });
  const b = await api("post", "/auth/login").send({ email: "nobody@example.com", password: "wrong-password" });
  assert.equal(a.status, 401);
  assert.deepEqual(a.body, b.body);
  assert.equal(a.body.error.code, "INVALID_CREDENTIALS");
});

test("me: без токена 401, с токеном — профиль", async () => {
  assert.equal((await api("get", "/auth/me")).status, 401);
  const r = await api("get", "/auth/me").set("Authorization", `Bearer ${session.accessToken}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.email, email);
});

test("refresh: ротация, повторное использование старого токена отзывает всю цепочку", async () => {
  const old = session.refreshToken;
  const r1 = await api("post", "/auth/refresh").send({ refreshToken: old });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refreshToken, old);

  const reuse = await api("post", "/auth/refresh").send({ refreshToken: old });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.error.code, "TOKEN_REUSED");

  // новый токен из той же цепочки тоже отозван
  const r2 = await api("post", "/auth/refresh").send({ refreshToken: r1.body.refreshToken });
  assert.equal(r2.status, 401);
});

test("login → logout: токен после выхода не работает", async () => {
  const l = await api("post", "/auth/login").send({ email, password });
  assert.equal(l.status, 200);
  const out = await api("post", "/auth/logout")
    .set("Authorization", `Bearer ${l.body.accessToken}`)
    .send({ refreshToken: l.body.refreshToken });
  assert.equal(out.status, 204);
  const r = await api("post", "/auth/refresh").send({ refreshToken: l.body.refreshToken });
  assert.equal(r.status, 401);
});

test("роли: requireRole('ADMIN') пускает только админа", () => {
  const run = (role) => {
    let err;
    requireRole("ADMIN")({ user: { role } }, {}, (e) => (err = e));
    return err;
  };
  assert.equal(run("ADMIN"), undefined);
  assert.equal(run("USER").status, 403);
});
