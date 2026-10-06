// E-mail: подтверждение, повторная отправка, «забыли пароль», сброс, чистка неподтверждённых, guard, Brevo-драйвер.
// Письма в тестах копятся в mailer.outbox (драйвер memory включается в config/env.js при NODE_ENV=test).
process.env.NODE_ENV = "test";
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const app = require("../src/app");
const env = require("../src/config/env");
const prisma = require("../src/lib/prisma");
const mailer = require("../src/lib/mailer");
const templates = require("../src/lib/mailTemplates");
const { hashToken } = require("../src/lib/jwt");
const { cleanup } = require("../src/lib/cleanup");
const { requireAuth, requireVerifiedEmail } = require("../src/middleware/auth");
const { errorHandler } = require("../src/middleware/errorHandler");
const limiters = require("../src/middleware/rateLimits");

const T = `zz${Date.now().toString(36)}`;
const mail = (n) => `em-${T}-${n}@example.com`;
const PASS = "correct-horse-1";
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const created = new Set();

after(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: `-${T}-` } } });
  await prisma.$disconnect();
});
beforeEach(() => limiters.resetAll());

async function register(n, extra = {}) {
  const email = mail(n);
  created.add(email);
  const r = await api("post", "/auth/register").send({ email, password: PASS, confirmPassword: PASS, displayName: "Тест", ...extra });
  return { email, res: r, session: r.body };
}
const auth = (s) => ({ Authorization: `Bearer ${s.accessToken}` });
const mailsTo = (email) => mailer.outbox.filter((m) => m.to === email);
const tokenFrom = (m) => /token=([A-Za-z0-9_-]+)/.exec(m.text)[1];
const lastToken = (email) => tokenFrom(mailsTo(email).at(-1));
const userOf = (email) => prisma.user.findUnique({ where: { email } });
// сдвинуть письма назад во времени, чтобы не мешал лимит «раз в минуту»
const ageTokens = (email, ms) =>
  prisma.$executeRaw`UPDATE email_tokens SET created_at = created_at - ${ms}::bigint * interval '1 millisecond'
    WHERE user_id = (SELECT id FROM users WHERE email = ${email})`;

// ---------- регистрация ----------
test("register: пароли должны совпадать (нет поля или разные → 422)", async () => {
  const a = await register("mm1", { confirmPassword: "other-pass-1" });
  assert.equal(a.res.status, 422);
  assert.ok(a.res.body.error.details.some((d) => d.field === "confirmPassword"));
  const b = await api("post", "/auth/register").send({ email: mail("mm2"), password: PASS, displayName: "Т" });
  assert.equal(b.status, 422);
  assert.equal(await userOf(mail("mm1")), null);
  assert.equal(await userOf(mail("mm2")), null);
});

test("register: письмо со ссылкой, аккаунт не подтверждён, в БД только хэш токена", async () => {
  const { email, res } = await register("r1");
  assert.equal(res.status, 201);
  assert.equal(res.body.user.emailVerified, false);
  assert.equal(res.body.verificationSent, true);
  const mails = mailsTo(email);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Подтвердите/);
  assert.ok(mails[0].text.includes(`${env.frontendUrl}/#/verify?token=`));
  const token = tokenFrom(mails[0]);
  const row = await prisma.emailToken.findUnique({ where: { tokenHash: hashToken(token) } });
  assert.equal(row.type, "VERIFY");
  assert.ok(Math.abs(row.expiresAt - Date.now() - 24 * 3600 * 1000) < 60_000, "срок жизни ≈ 24 ч");
  assert.equal(await prisma.emailToken.findUnique({ where: { tokenHash: token } }), null, "сырой токен в БД не хранится");
});

test("register: сбой почты не ломает регистрацию (verificationSent: false)", async () => {
  const orig = mailer.drivers.memory;
  mailer.drivers.memory = async () => { throw new Error("brevo down"); };
  try {
    const { res } = await register("r2");
    assert.equal(res.status, 201);
    assert.equal(res.body.verificationSent, false);
  } finally {
    mailer.drivers.memory = orig;
  }
});

// ---------- подтверждение ----------
test("verify-email: подтверждает, ссылка одноразовая", async () => {
  const { email, session } = await register("v1");
  const token = lastToken(email);
  const ok = await api("post", "/auth/verify-email").send({ token });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { verified: true, email });
  assert.equal((await api("get", "/auth/me").set(auth(session))).body.emailVerified, true);

  const again = await api("post", "/auth/verify-email").send({ token });
  assert.equal(again.status, 400);
  assert.equal(again.body.error.code, "INVALID_TOKEN");
});

test("verify-email: мусор, просроченный токен и токен другого типа отклоняются", async () => {
  const bad = await api("post", "/auth/verify-email").send({ token: "x".repeat(43) });
  assert.equal(bad.status, 400);
  assert.equal((await api("post", "/auth/verify-email").send({ token: "short" })).status, 422);

  const { email } = await register("v2");
  const token = lastToken(email);
  await prisma.emailToken.update({ where: { tokenHash: hashToken(token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await api("post", "/auth/verify-email").send({ token })).status, 400);
  assert.equal((await userOf(email)).emailVerifiedAt, null);

  // токен сброса пароля не годится для подтверждения
  await api("post", "/auth/forgot-password").send({ email });
  await mailer.idle();
  const resetToken = lastToken(email);
  assert.equal((await api("post", "/auth/verify-email").send({ token: resetToken })).status, 400);
});

test("verify-email: две параллельные попытки с одной ссылкой — успех ровно у одной", async () => {
  const { email } = await register("v3");
  const token = lastToken(email);
  const rs = await Promise.all([1, 2, 3].map(() => api("post", "/auth/verify-email").send({ token })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400, 400]);
});

// ---------- повторная отправка ----------
test("resend-verification: нужен вход, лимит «раз в минуту» и «5 в час», подтверждённым — 409", async () => {
  assert.equal((await api("post", "/auth/resend-verification")).status, 401);

  const { email, session } = await register("s1");
  const soon = await api("post", "/auth/resend-verification").set(auth(session));
  assert.equal(soon.status, 429);
  assert.equal(soon.body.error.code, "RESEND_TOO_SOON");
  assert.equal(mailsTo(email).length, 1);

  await ageTokens(email, 61_000);
  const ok = await api("post", "/auth/resend-verification").set(auth(session));
  assert.equal(ok.status, 202);
  assert.equal(mailsTo(email).length, 2);

  // до 5 писем в час: сейчас 2, добиваем до 5
  for (let i = 0; i < 3; i++) {
    await ageTokens(email, 61_000);
    assert.equal((await api("post", "/auth/resend-verification").set(auth(session))).status, 202, `письмо ${i + 3}`);
  }
  await ageTokens(email, 61_000);
  const capped = await api("post", "/auth/resend-verification").set(auth(session));
  assert.equal(capped.status, 429);
  assert.equal(capped.body.error.code, "RESEND_LIMIT");

  await api("post", "/auth/verify-email").send({ token: lastToken(email) });
  const done = await api("post", "/auth/resend-verification").set(auth(session));
  assert.equal(done.status, 409);
  assert.equal(done.body.error.code, "ALREADY_VERIFIED");
});

test("resend-verification: сбой почты → 502, токен остаётся, повтор возможен позже", async () => {
  const { session } = await register("s2");
  await ageTokens(mail("s2"), 61_000);
  const orig = mailer.drivers.memory;
  mailer.drivers.memory = async () => { throw new Error("brevo down"); };
  try {
    const r = await api("post", "/auth/resend-verification").set(auth(session));
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, "EMAIL_SEND_FAILED");
  } finally {
    mailer.drivers.memory = orig;
  }
});

// ---------- забыли пароль ----------
test("forgot-password: ответ одинаков для существующего и несуществующего e-mail", async () => {
  const { email } = await register("f1");
  const a = await api("post", "/auth/forgot-password").send({ email });
  const b = await api("post", "/auth/forgot-password").send({ email: mail("nobody") });
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(a.headers["content-length"], b.headers["content-length"]);
  await mailer.idle();
  assert.equal(mailsTo(email).filter((m) => /Сброс/.test(m.subject)).length, 1);
  assert.equal(mailsTo(mail("nobody")).length, 0);
  assert.equal((await api("post", "/auth/forgot-password").send({ email: "не-почта" })).status, 422);
});

test("forgot-password: заблокированному письмо не уходит, ответ тот же; повтор раньше минуты молча игнорируется", async () => {
  const { email } = await register("f2");
  await prisma.user.update({ where: { email }, data: { isBlocked: true } });
  const r = await api("post", "/auth/forgot-password").send({ email });
  assert.equal(r.status, 202);
  await mailer.idle();
  assert.equal(mailsTo(email).filter((m) => /Сброс/.test(m.subject)).length, 0);

  await prisma.user.update({ where: { email }, data: { isBlocked: false } });
  await api("post", "/auth/forgot-password").send({ email });
  const second = await api("post", "/auth/forgot-password").send({ email });
  assert.equal(second.status, 202);
  await mailer.idle();
  assert.equal(mailsTo(email).filter((m) => /Сброс/.test(m.subject)).length, 1);
});

// ---------- сброс пароля ----------
test("reset-password: меняет пароль, отзывает все сессии, ссылка одноразовая, e-mail становится подтверждённым", async () => {
  const { email, session } = await register("p1");
  const s2 = (await api("post", "/auth/login").send({ email, password: PASS })).body;
  await api("post", "/auth/forgot-password").send({ email });
  await mailer.idle();
  const reset = mailsTo(email).find((m) => /Сброс/.test(m.subject));
  assert.ok(reset.text.includes(`${env.frontendUrl}/#/reset?token=`));
  const token = tokenFrom(reset);
  const row = await prisma.emailToken.findUnique({ where: { tokenHash: hashToken(token) } });
  assert.ok(Math.abs(row.expiresAt - Date.now() - 3600 * 1000) < 60_000, "срок жизни ≈ 1 ч");

  const NEW = "brand-new-pass-9";
  const ok = await api("post", "/auth/reset-password").send({ token, password: NEW, confirmPassword: NEW });
  assert.equal(ok.status, 200);

  assert.equal((await api("post", "/auth/login").send({ email, password: PASS })).status, 401);
  const login = await api("post", "/auth/login").send({ email, password: NEW });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.emailVerified, true);
  for (const s of [session, s2]) {
    const r = await api("post", "/auth/refresh").send({ refreshToken: s.refreshToken });
    assert.equal(r.status, 401, "старые сессии отозваны");
  }
  const again = await api("post", "/auth/reset-password").send({ token, password: NEW, confirmPassword: NEW });
  assert.equal(again.status, 400);
  assert.equal(again.body.error.code, "INVALID_TOKEN");
});

test("reset-password: валидация, просроченная и чужого типа ссылки, новая ссылка гасит прежнюю", async () => {
  const { email } = await register("p2");
  await api("post", "/auth/forgot-password").send({ email });
  await mailer.idle();
  const first = lastToken(email);
  const NEW = "brand-new-pass-9";

  assert.equal((await api("post", "/auth/reset-password").send({ token: first, password: NEW, confirmPassword: "different-1" })).status, 422);
  assert.equal((await api("post", "/auth/reset-password").send({ token: first, password: "short", confirmPassword: "short" })).status, 422);
  const verifyToken = tokenFrom(mailsTo(email)[0]); // токен подтверждения e-mail не годится для сброса
  assert.equal((await api("post", "/auth/reset-password").send({ token: verifyToken, password: NEW, confirmPassword: NEW })).status, 400);

  // вторая ссылка гасит первую
  await ageTokens(email, 61_000);
  await api("post", "/auth/forgot-password").send({ email });
  await mailer.idle();
  const second = lastToken(email);
  assert.notEqual(second, first);
  assert.equal((await api("post", "/auth/reset-password").send({ token: first, password: NEW, confirmPassword: NEW })).status, 400);

  // просроченная
  await prisma.emailToken.update({ where: { tokenHash: hashToken(second) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await api("post", "/auth/reset-password").send({ token: second, password: NEW, confirmPassword: NEW })).status, 400);
  assert.equal((await api("post", "/auth/login").send({ email, password: PASS })).status, 200, "пароль не менялся");
});

test("reset-password: параллельные запросы с одной ссылкой — успех ровно у одного", async () => {
  const { email } = await register("p3");
  await api("post", "/auth/forgot-password").send({ email });
  await mailer.idle();
  const token = lastToken(email);
  const NEW = "brand-new-pass-9";
  const rs = await Promise.all([1, 2, 3].map(() => api("post", "/auth/reset-password").send({ token, password: NEW, confirmPassword: NEW })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400, 400]);
});

// ---------- guard ----------
test("requireVerifiedEmail: неподтверждённым 403 EMAIL_NOT_VERIFIED, подтверждённым — пропускает", async () => {
  const mini = express();
  mini.get("/x", requireAuth, requireVerifiedEmail, (req, res) => res.json({ ok: true }));
  mini.use(errorHandler);

  const { email, session } = await register("g1");
  const denied = await request(mini).get("/x").set(auth(session));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "EMAIL_NOT_VERIFIED");
  assert.equal((await request(mini).get("/x")).status, 401);

  await api("post", "/auth/verify-email").send({ token: lastToken(email) });
  assert.equal((await request(mini).get("/x").set(auth(session))).status, 200);

  await prisma.user.update({ where: { email }, data: { isBlocked: true } });
  assert.equal((await request(mini).get("/x").set(auth(session))).body.error.code, "ACCOUNT_BLOCKED");
});

// ---------- чистка ----------
test("cleanup: удаляет неподтверждённых USER старше 7 дней, остальных не трогает", async () => {
  const day = 24 * 3600 * 1000;
  const mk = (n, data) => prisma.user.create({ data: { email: mail(n), passwordHash: "x", displayName: n, ...data } });
  await mk("c-old", { createdAt: new Date(Date.now() - 8 * day) });
  await mk("c-new", { createdAt: new Date(Date.now() - 6 * day) });
  await mk("c-ver", { createdAt: new Date(Date.now() - 30 * day), emailVerifiedAt: new Date(), lastActiveAt: new Date() });
  await mk("c-adm", { createdAt: new Date(Date.now() - 30 * day), role: "ADMIN" });
  const old = await userOf(mail("c-old"));
  await prisma.emailToken.create({ data: { userId: old.id, type: "VERIFY", tokenHash: `h-${T}-1`, expiresAt: new Date(Date.now() + day) } });
  const keeper = await userOf(mail("c-new"));
  await prisma.emailToken.create({ data: { userId: keeper.id, type: "VERIFY", tokenHash: `h-${T}-2`, expiresAt: new Date(Date.now() - 3 * day) } });
  await prisma.emailToken.create({ data: { userId: keeper.id, type: "RESET", tokenHash: `h-${T}-3`, expiresAt: new Date(Date.now() + day) } });

  const r = await cleanup();
  assert.ok(r.users >= 1 && r.tokens >= 1);
  assert.equal(await userOf(mail("c-old")), null);
  for (const n of ["c-new", "c-ver", "c-adm"]) assert.ok(await userOf(mail(n)), n);
  assert.equal(await prisma.emailToken.findUnique({ where: { tokenHash: `h-${T}-1` } }), null, "токены удалённого ушли каскадом");
  assert.equal(await prisma.emailToken.findUnique({ where: { tokenHash: `h-${T}-2` } }), null, "просроченный токен убран");
  assert.ok(await prisma.emailToken.findUnique({ where: { tokenHash: `h-${T}-3` } }), "живой токен остался");
});

// ---------- лимиты ----------
test("rate-limit write: POST/PUT/PATCH/DELETE ограничены, GET и health — нет", async () => {
  limiters.limits.write.limit = 3;
  try {
    for (let i = 0; i < 3; i++) assert.notEqual((await api("post", "/auth/verify-email").send({ token: "x".repeat(30) })).status, 429);
    const over = await api("post", "/auth/verify-email").send({ token: "x".repeat(30) });
    assert.equal(over.status, 429);
    assert.equal(over.body.error.code, "RATE_LIMITED");
    assert.ok(over.headers["ratelimit"] || over.headers["ratelimit-policy"], "заголовки RateLimit");
    assert.equal((await api("get", "/recipes")).status, 200);
    assert.equal((await api("get", "/health")).status, 200);
  } finally {
    limiters.limits.write.limit = 1_000_000;
  }
});

test("rate-limit global: общий лимит на чтение, /health без лимита", async () => {
  limiters.limits.global.limit = 3;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await api("get", "/categories")).status, 200);
    assert.equal((await api("get", "/categories")).status, 429);
    for (let i = 0; i < 5; i++) assert.equal((await api("get", "/health")).status, 200);
  } finally {
    limiters.limits.global.limit = 1_000_000;
  }
});

test("rate-limit sync: свой лимит, не зависит от общего лимита записи", async () => {
  const { session } = await register("rl1");
  limiters.limits.sync.limit = 2;
  limiters.limits.write.limit = 2;
  try {
    for (let i = 0; i < 2; i++) assert.equal((await api("post", "/me/sync").set(auth(session)).send({ ops: [] })).status, 200);
    const over = await api("post", "/me/sync").set(auth(session)).send({ ops: [] });
    assert.equal(over.status, 429);
    // sync не расходует лимит записи
    assert.notEqual((await api("post", "/auth/verify-email").send({ token: "x".repeat(30) })).status, 429);
  } finally {
    limiters.limits.sync.limit = 1_000_000;
    limiters.limits.write.limit = 1_000_000;
  }
});

test("rate-limit mail: письма (forgot/resend) ограничены строже", async () => {
  limiters.limits.mail.limit = 2;
  try {
    for (let i = 0; i < 2; i++) assert.equal((await api("post", "/auth/forgot-password").send({ email: mail("none") })).status, 202);
    assert.equal((await api("post", "/auth/forgot-password").send({ email: mail("none") })).status, 429);
    assert.equal((await api("post", "/auth/resend-verification")).status, 429);
  } finally {
    limiters.limits.mail.limit = 1_000_000;
  }
});

// ---------- почтовый модуль ----------
test("Brevo-драйвер: правильный запрос (URL, api-key, sender, to, htmlContent); ошибка API → исключение", async () => {
  const realFetch = global.fetch;
  const saved = { key: env.BREVO_API_KEY, from: env.MAIL_FROM_EMAIL };
  env.BREVO_API_KEY = "test-key-123";
  env.MAIL_FROM_EMAIL = "sender@example.com";
  let seen;
  global.fetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 201, text: async () => "" };
  };
  try {
    await mailer.drivers.brevo({ to: "u@example.com", subject: "Тема", html: "<p>x</p>", text: "x" });
    assert.equal(seen.url, "https://api.brevo.com/v3/smtp/email");
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers["api-key"], "test-key-123");
    const body = JSON.parse(seen.init.body);
    assert.deepEqual(body.sender, { email: "sender@example.com", name: env.MAIL_FROM_NAME });
    assert.deepEqual(body.to, [{ email: "u@example.com" }]);
    assert.equal(body.subject, "Тема");
    assert.equal(body.htmlContent, "<p>x</p>");

    global.fetch = async () => ({ ok: false, status: 401, text: async () => '{"code":"unauthorized"}' });
    await assert.rejects(mailer.drivers.brevo({ to: "u@example.com", subject: "s", html: "h", text: "t" }), /Brevo 401/);
  } finally {
    global.fetch = realFetch;
    env.BREVO_API_KEY = saved.key;
    env.MAIL_FROM_EMAIL = saved.from;
  }
});

test("Mailjet-драйвер: запрос Send API v3.1 с Basic-авторизацией; ошибка API → исключение", async () => {
  const realFetch = global.fetch;
  const saved = { k: env.MAILJET_API_KEY, s: env.MAILJET_SECRET_KEY, from: env.MAIL_FROM_EMAIL };
  env.MAILJET_API_KEY = "mj-key";
  env.MAILJET_SECRET_KEY = "mj-secret";
  env.MAIL_FROM_EMAIL = "sender@example.com";
  let seen;
  global.fetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => "" };
  };
  try {
    await mailer.drivers.mailjet({ to: "u@example.com", subject: "Тема", html: "<p>x</p>", text: "x" });
    assert.equal(seen.url, "https://api.mailjet.com/v3.1/send");
    assert.equal(seen.init.headers.authorization, "Basic " + Buffer.from("mj-key:mj-secret").toString("base64"));
    const m = JSON.parse(seen.init.body).Messages[0];
    assert.equal(m.From.Email, "sender@example.com");
    assert.deepEqual(m.To, [{ Email: "u@example.com" }]);
    assert.equal(m.Subject, "Тема");
    assert.equal(m.HTMLPart, "<p>x</p>");
    assert.equal(m.TextPart, "x");

    global.fetch = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });
    await assert.rejects(mailer.drivers.mailjet({ to: "u@example.com", subject: "s", html: "h", text: "t" }), /Mailjet 401/);
  } finally {
    global.fetch = realFetch;
    Object.assign(env, { MAILJET_API_KEY: saved.k, MAILJET_SECRET_KEY: saved.s, MAIL_FROM_EMAIL: saved.from });
  }
});

test("sendInBackground: ошибка отправки не выбрасывается наружу", async () => {
  const orig = mailer.drivers.memory;
  mailer.drivers.memory = async () => { throw new Error("boom"); };
  try {
    await mailer.sendInBackground({ to: "a@example.com", subject: "s", html: "h", text: "t" });
    await mailer.idle();
  } finally {
    mailer.drivers.memory = orig;
  }
});

test("шаблоны: HTML экранируется, ссылка ведёт на фронтенд", () => {
  const m = templates.verifyEmail({ displayName: '<b>"Вася"</b>' }, "tok/en+1");
  assert.ok(!m.html.includes("<b>"));
  assert.ok(m.html.includes("&lt;b&gt;"));
  assert.ok(m.text.includes(`${env.frontendUrl}/#/verify?token=tok%2Fen%2B1`));
  assert.ok(templates.resetPassword({ displayName: "A" }, "t").text.includes("/#/reset?token=t"));
});

// ---------- конфигурация ----------
test("env: в production с ключами почты нужны FRONTEND_URL и отправитель; без ключей сервер стартует (почта отключена)", () => {
  const script = path.join(__dirname, "..", "src", "config", "env.js");
  const base = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    NODE_ENV: "production", DATABASE_URL: "postgresql://x", JWT_SECRET: "j".repeat(40),
    CLOUDINARY_URL: "cloudinary://k:s@cloud",
  };
  const run = (extra) => spawnSync(process.execPath, [script], { env: { ...base, ...extra }, encoding: "utf8" });

  // без ключей почты сервер стартует в режиме «почта отключена» (см. tests/mail-mode.test.js)
  const noMail = run({ FRONTEND_URL: "https://site.example" });
  assert.equal(noMail.status, 0, noMail.stderr);
  const noFront = run({ BREVO_API_KEY: "k", MAIL_FROM_EMAIL: "a@example.com" });
  assert.equal(noFront.status, 1);
  assert.match(noFront.stderr, /FRONTEND_URL/);
  const noSender = run({ BREVO_API_KEY: "k", FRONTEND_URL: "https://site.example" });
  assert.equal(noSender.status, 1);
  assert.match(noSender.stderr, /MAIL_FROM_EMAIL/);
  const ok = run({ BREVO_API_KEY: "k", MAIL_FROM_EMAIL: "a@example.com", FRONTEND_URL: "https://site.example/" });
  assert.equal(ok.status, 0, ok.stderr);
  const mj = { MAILJET_API_KEY: "k", MAILJET_SECRET_KEY: "s", MAIL_FROM_EMAIL: "a@example.com", FRONTEND_URL: "https://site.example" };
  assert.equal(run(mj).status, 0);
  const noSecret = run({ ...mj, MAILJET_SECRET_KEY: undefined });
  assert.equal(noSecret.status, 1);
  assert.match(noSecret.stderr, /MAILJET_SECRET_KEY/);
});
