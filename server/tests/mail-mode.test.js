// Режимы почты: включена (по умолчанию в тестах) и «почта отключена» (production без ключей Brevo/Mailjet).
// Переключение на лету — через env.mailEnabled; выбор режима по переменным окружения — в дочернем процессе.
process.env.NODE_ENV = "test";
process.env.STORAGE_DRIVER = "local";
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const app = require("../src/app");
const env = require("../src/config/env");
const prisma = require("../src/lib/prisma");
const mailer = require("../src/lib/mailer");
const storage = require("../src/lib/storage");
const limiters = require("../src/middleware/rateLimits");
const { cleanup } = require("../src/lib/cleanup");

const T = `zm${Date.now().toString(36)}`;
const PASS = "correct-horse-1";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex");
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const auth = (s) => ({ Authorization: `Bearer ${s.accessToken}` });
const mail = (n) => `mm-${T}-${n}@example.com`;
const CAT = `Почта ${T}`;
const userOf = (email) => prisma.user.findUnique({ where: { email } });

async function withMail(enabled, fn) {
  const was = env.mailEnabled;
  env.mailEnabled = enabled;
  try {
    return await fn();
  } finally {
    env.mailEnabled = was;
  }
}
const register = (n) => api("post", "/auth/register").send({ email: mail(n), password: PASS, confirmPassword: PASS, displayName: "Тест" });
const recipe = () => ({
  title: `Суп ${T}`, category: CAT, main: ["Первое"], ingredients: [{ name: "Вода" }], steps: [{ text: "Варить" }],
});

beforeEach(() => limiters.resetAll());
after(async () => {
  const users = await prisma.user.findMany({ where: { email: { contains: `-${T}-` } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const imgs = (await prisma.recipe.findMany({ where: { authorId: { in: ids } }, select: { image: true } })).map((r) => r.image);
  await prisma.recipe.deleteMany({ where: { authorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.category.deleteMany({ where: { slug: { contains: T } } });
  for (const i of imgs) await storage.remove(i);
  await prisma.$disconnect();
});

// ---------- публичный флаг ----------

test("GET /config отдаёт mailEnabled в обоих режимах", async () => {
  assert.equal((await api("get", "/config")).body.mailEnabled, true);
  await withMail(false, async () => {
    const r = await api("get", "/config");
    assert.equal(r.status, 200);
    assert.equal(r.body.mailEnabled, false);
    assert.equal(r.body.submissionsPerDay, env.SUBMISSIONS_PER_DAY);
  });
});

// ---------- почта включена ----------

test("почта включена: регистрация не подтверждена, письмо ушло, предлагать рецепты нельзя до подтверждения", async () => {
  const before = mailer.outbox.length;
  const r = await register("on1");
  assert.equal(r.status, 201);
  assert.equal(r.body.user.emailVerified, false);
  assert.equal(r.body.verificationSent, true);
  assert.equal(mailer.outbox.length, before + 1);
  assert.equal((await userOf(mail("on1"))).emailVerifiedAt, null);
  const sub = await api("post", "/me/submissions").set(auth(r.body)).send(recipe());
  assert.equal(sub.body.error.code, "EMAIL_NOT_VERIFIED");
  assert.equal((await api("post", "/auth/forgot-password").send({ email: mail("on1") })).status, 202);
});

// ---------- почта отключена ----------

test("почта отключена: новый пользователь сразу подтверждён, письма не отправляются, токенов нет", async () => {
  await withMail(false, async () => {
    const before = mailer.outbox.length;
    const r = await register("off1");
    assert.equal(r.status, 201);
    assert.equal(r.body.user.emailVerified, true);
    assert.equal(r.body.verificationSent, false);
    const u = await userOf(mail("off1"));
    assert.ok(u.emailVerifiedAt, "email_verified_at = now");
    assert.equal(await prisma.emailToken.count({ where: { userId: u.id } }), 0);
    assert.equal(mailer.outbox.length, before);
    assert.equal((await api("get", "/auth/me").set(auth(r.body))).body.emailVerified, true);
  });
});

test("почта отключена: можно сразу предлагать рецепты и загружать фото", async () => {
  await prisma.category.create({ data: { name: CAT, slug: `pochta-${T}` } });
  await withMail(false, async () => {
    const s = (await register("off2")).body;
    const up = await api("post", "/uploads/image").set(auth(s)).attach("file", PNG, "a.png");
    assert.equal(up.status, 201);
    const r = await api("post", "/me/submissions").set(auth(s)).send({ ...recipe(), image: up.body.url });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "PENDING");
  });
});

test("почта отключена: «забыли пароль» и повторная отправка — понятный 503 MAIL_DISABLED, не 500; тело не зависит от e-mail", async () => {
  const existing = (await register("off3")).body; // зарегистрирован при включённой почте → не подтверждён
  await withMail(false, async () => {
    const before = mailer.outbox.length;
    const a = await api("post", "/auth/forgot-password").send({ email: mail("off3") });
    const b = await api("post", "/auth/forgot-password").send({ email: mail("nobody") });
    for (const r of [a, b]) {
      assert.equal(r.status, 503);
      assert.equal(r.body.error.code, "MAIL_DISABLED");
      assert.match(r.body.error.message, /временно недоступн/);
    }
    assert.deepEqual(a.body, b.body, "ответ не раскрывает, есть ли такой e-mail");
    const rs = await api("post", "/auth/resend-verification").set(auth(existing));
    assert.equal(rs.status, 503);
    assert.equal(rs.body.error.code, "MAIL_DISABLED");
    assert.equal(mailer.outbox.length, before);
    assert.equal(await prisma.emailToken.count({ where: { user: { email: mail("off3") }, type: "RESET" } }), 0);
    // наружу виден как подтверждённый, ограничений на предложения нет
    const login = await api("post", "/auth/login").send({ email: mail("off3"), password: PASS });
    assert.equal(login.body.user.emailVerified, true);
    const sub = await api("post", "/me/submissions").set(auth(login.body)).send(recipe());
    assert.equal(sub.status, 201);
  });
  // почту включили — прежние правила возвращаются сами, без правок кода
  const login = await api("post", "/auth/login").send({ email: mail("off3"), password: PASS });
  assert.equal(login.body.user.emailVerified, false);
  assert.equal((await api("post", "/me/submissions").set(auth(login.body)).send(recipe())).body.error.code, "EMAIL_NOT_VERIFIED");
  assert.equal((await api("post", "/auth/forgot-password").send({ email: mail("off3") })).status, 202);
});

test("драйвер off не отправляет письма: бросает MAIL_DISABLED", async () => {
  await assert.rejects(mailer.drivers.off({ to: "a@b.c", subject: "x", html: "", text: "" }), { code: "MAIL_DISABLED" });
  await withMail(false, async () => assert.throws(() => mailer.assertEnabled(), { code: "MAIL_DISABLED" }));
  assert.doesNotThrow(() => mailer.assertEnabled());
});

test("автоочистка неподтверждённых: при отключённой почте не трогает, при включённой — удаляет", async () => {
  const email = mail("old1");
  await prisma.user.create({ data: { email, passwordHash: "x", displayName: "Старый", createdAt: new Date(Date.now() - 10 * 86400000) } });
  await withMail(false, async () => {
    await cleanup();
    assert.ok(await userOf(email), "не удалён, пока почта отключена");
  });
  await cleanup();
  assert.equal(await userOf(email), null, "при включённой почте неподтверждённый удаляется");
});

// ---------- выбор режима по окружению (дочерний процесс) ----------

function modeFor(vars) {
  const code = `const e=require("./src/config/env");console.log(JSON.stringify({d:e.mailDriver,on:e.mailEnabled}))`;
  const res = spawnSync(process.execPath, ["-e", code], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env, NODE_ENV: "production", CLOUDINARY_URL: "cloudinary://k:s@demo", FRONTEND_URL: "https://example.com",
      STORAGE_DRIVER: "", MAILJET_API_KEY: "", MAILJET_SECRET_KEY: "", BREVO_API_KEY: "", MAIL_FROM_EMAIL: "", MAIL_DRIVER: "", ...vars,
    },
  });
  return { status: res.status, out: res.stdout.trim(), err: res.stderr };
}

test("production без ключей: конфигурация проходит, режим «почта отключена»", () => {
  const r = modeFor({});
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { d: "off", on: false });
  // log/memory в production почтой не считаются
  assert.deepEqual(JSON.parse(modeFor({ MAIL_DRIVER: "log" }).out), { d: "off", on: false });
  // FRONTEND_URL при отключённой почте не нужен
  const noUrl = modeFor({ FRONTEND_URL: "" });
  assert.equal(noUrl.status, 0, noUrl.err);
});

test("production с ключами Mailjet/Brevo: почта включается сама; неполные ключи — ошибка конфигурации", () => {
  const mj = modeFor({ MAILJET_API_KEY: "k", MAILJET_SECRET_KEY: "s", MAIL_FROM_EMAIL: "noreply@example.com" });
  assert.equal(mj.status, 0, mj.err);
  assert.deepEqual(JSON.parse(mj.out), { d: "mailjet", on: true });
  const br = modeFor({ BREVO_API_KEY: "k", MAIL_FROM_EMAIL: "noreply@example.com" });
  assert.deepEqual(JSON.parse(br.out), { d: "brevo", on: true });
  const partial = modeFor({ MAILJET_API_KEY: "k" });
  assert.notEqual(partial.status, 0);
  assert.match(partial.err, /Mailjet/);
  const noFront = modeFor({ MAILJET_API_KEY: "k", MAILJET_SECRET_KEY: "s", MAIL_FROM_EMAIL: "noreply@example.com", FRONTEND_URL: "" });
  assert.notEqual(noFront.status, 0);
  assert.match(noFront.err, /FRONTEND_URL/);
});
