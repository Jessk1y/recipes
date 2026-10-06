// Защита от массовых регистраций: капча Turnstile, канонический адрес Gmail, глобальный предохранитель,
// группировка пушей о предложениях, очистка аккаунтов без единого действия.
// Идёт в отдельной схеме Postgres: предохранитель и очистка считают всех пользователей в БД,
// а наборы тестов выполняются параллельно.
const { execSync } = require("node:child_process");
const path = require("node:path");

require("dotenv").config();
const testUrl = new URL(process.env.DATABASE_URL);
testUrl.searchParams.set("schema", "recipes_abuse_test");
process.env.DATABASE_URL = testUrl.toString(); // dotenv не перезаписывает уже заданные переменные
process.env.NODE_ENV = "test";
process.env.STORAGE_DRIVER = "local";
execSync("node node_modules/prisma/build/index.js migrate deploy", { cwd: path.join(__dirname, ".."), stdio: "pipe" });

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const webpush = require("web-push");
const app = require("../src/app");
const env = require("../src/config/env");
const prisma = require("../src/lib/prisma");
const push = require("../src/lib/push");
const turnstile = require("../src/lib/turnstile");
const regFuse = require("../src/lib/regFuse");
const batch = require("../src/lib/submissionBatch");
const { emailKey } = require("../src/lib/emailKey");
const { cleanup, INACTIVE_TTL_MS } = require("../src/lib/cleanup");
const limiters = require("../src/middleware/rateLimits");
const { signAccessToken } = require("../src/lib/jwt");

const T = `za${Date.now().toString(36)}`;
const DAY = 86400000;
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const as = (u, m, url) => api(m, url).set("Authorization", `Bearer ${u.token}`);
const CAT = `Тест ${T}`;
const PASSWORD = "correct-horse-1";
const mail = (name) => `${name}-${T}@abuse-test.example.com`;
const reg = (email, extra = {}) =>
  api("post", "/auth/register").send({ email, password: PASSWORD, confirmPassword: PASSWORD, displayName: "Тест", ...extra });
const userOf = (email) => prisma.user.findUnique({ where: { email } });
const input = (extra = {}) => ({
  title: `Суп ${T}`, category: CAT, main: ["Первое"], tags: [], time: "30 мин", servings: "2",
  ingredients: [{ name: "Вода", amount: "1 л" }], steps: [{ text: "Варить" }], ...extra,
});

async function mkUser(name, data = {}) {
  const u = await prisma.user.create({
    data: { email: mail(name), passwordHash: "x", displayName: name, emailVerifiedAt: new Date(), ...data },
  });
  return { id: u.id, token: signAccessToken(u) };
}

// подменяемый отправитель push: запоминает, что ушло админам
let sent;
const stub = async (s, payload) => { sent.push(JSON.parse(payload)); };

const saved = { pushEnabled: env.pushEnabled, pub: env.VAPID_PUBLIC_KEY, priv: env.VAPID_PRIVATE_KEY };
let admin;
before(async () => {
  const keys = webpush.generateVAPIDKeys();
  Object.assign(env, { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, pushEnabled: true });
  push.setSender(stub);
  await prisma.category.create({ data: { name: CAT, slug: `test-${T}` } });
  admin = await mkUser("admin", { role: "ADMIN" });
  await prisma.pushSubscription.create({
    data: { userId: admin.id, endpoint: `https://push.example.test/send/${T}`, p256dh: "p", auth: "a" },
  });
});
beforeEach(() => {
  limiters.resetAll();
  sent = [];
  env.turnstileEnabled = false;
  regFuse.limits.perHour = 1_000_000;
  regFuse.resetAlert();
  batch.reset();
  batch.config.windowMs = 0;
});
after(async () => {
  Object.assign(env, { pushEnabled: saved.pushEnabled, VAPID_PUBLIC_KEY: saved.pub, VAPID_PRIVATE_KEY: saved.priv, turnstileEnabled: false });
  push.setSender(null);
  turnstile.setVerifier(null);
  await prisma.recipe.deleteMany({ where: { category: { slug: `test-${T}` } } });
  await prisma.user.deleteMany({ where: { email: { contains: T } } });
  await prisma.category.deleteMany({ where: { slug: `test-${T}` } });
  await prisma.$disconnect();
});

// ---------- Turnstile ----------

test("капча выключена (нет ключей): регистрация проходит без токена, /config даёт turnstileSiteKey null", async () => {
  assert.equal((await reg(mail("nocaptcha"))).status, 201);
  assert.equal((await api("get", "/config")).body.turnstileSiteKey, null);
});

test("капча включена: без токена 400 CAPTCHA_REQUIRED, плохой токен 400 CAPTCHA_FAILED, хороший — 201; аккаунт не создаётся", async () => {
  env.turnstileEnabled = true;
  env.TURNSTILE_SITE_KEY = "site-key-public";
  const seen = [];
  turnstile.setVerifier(async (token, ip) => { seen.push({ token, ip }); return { success: token === "good", codes: [] }; });

  let r = await reg(mail("cap1"));
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "CAPTCHA_REQUIRED");
  r = await reg(mail("cap1"), { turnstileToken: "" });
  assert.equal(r.body.error.code, "CAPTCHA_REQUIRED");
  r = await reg(mail("cap1"), { turnstileToken: { $ne: 1 } });
  assert.equal(r.body.error.code, "CAPTCHA_REQUIRED", "не строка — как отсутствие токена");
  r = await reg(mail("cap1"), { turnstileToken: "bad" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "CAPTCHA_FAILED");
  assert.equal(await userOf(mail("cap1")), null, "до регистрации дело не дошло");

  r = await reg(mail("cap1"), { turnstileToken: "good" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(await userOf(mail("cap1")));
  assert.deepEqual(seen.map((s) => s.token), ["bad", "good"], "в проверку уходит именно присланный токен");

  assert.equal((await api("get", "/config")).body.turnstileSiteKey, "site-key-public");
  // вход капчей не защищён: у настоящих пользователей не должно быть лишних шагов
  assert.equal((await api("post", "/auth/login").send({ email: mail("cap1"), password: PASSWORD })).status, 200);
});

test("капча: сбой Cloudflare и internal-error — 503 (не 400): человека просим повторить, а не считаем ботом", async () => {
  env.turnstileEnabled = true;
  turnstile.setVerifier(async () => { throw new Error("network down"); });
  let r = await reg(mail("cap2"), { turnstileToken: "x" });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "CAPTCHA_UNAVAILABLE");
  turnstile.setVerifier(async () => ({ success: false, codes: ["internal-error"] }));
  r = await reg(mail("cap2"), { turnstileToken: "x" });
  assert.equal(r.status, 503);
  assert.equal(await userOf(mail("cap2")), null);
});

test("капча в предложении рецепта: нужна в POST, не нужна в PUT (правка/повторная отправка уже существующего)", async () => {
  const alice = await mkUser("alice");
  env.turnstileEnabled = true;
  turnstile.setVerifier(async (token) => ({ success: token === "good", codes: [] }));
  assert.equal((await as(alice, "post", "/me/submissions").send(input())).body.error.code, "CAPTCHA_REQUIRED");
  assert.equal((await as(alice, "post", "/me/submissions").send(input({ turnstileToken: "bad" }))).body.error.code, "CAPTCHA_FAILED");
  assert.equal(await prisma.recipe.count({ where: { author: { email: mail("alice") } } }), 0);
  const ok = await as(alice, "post", "/me/submissions").send(input({ turnstileToken: "good" }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.turnstileToken, undefined);
  const put = await as(alice, "put", `/me/submissions/${ok.body.id}`).send(input({ title: `Другой ${T}` }));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  await push.idle();
});

test("капча в предложении: сначала права, потом капча (неподтверждённому e-mail — 403, а не расход токена)", async () => {
  const carol = await mkUser("carol", { emailVerifiedAt: null });
  env.turnstileEnabled = true;
  let calls = 0;
  turnstile.setVerifier(async () => { calls++; return { success: true, codes: [] }; });
  // в режиме «почта отключена» неподтверждённых нет; включаем почту, как в боевом режиме с ключами
  const was = env.mailEnabled;
  env.mailEnabled = true;
  try {
    const r = await as(carol, "post", "/me/submissions").send(input({ turnstileToken: "good" }));
    assert.equal(r.status, 403);
    assert.equal(calls, 0);
  } finally {
    env.mailEnabled = was;
  }
});

test("настоящий проверяющий: POST на siteverify с секретом, токеном и IP; ответ success разбирается", async () => {
  env.turnstileEnabled = true;
  env.TURNSTILE_SECRET_KEY = "secret-xyz";
  turnstile.setVerifier(null); // вернуть реальный
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts, body: new URLSearchParams(opts.body.toString()) });
    return new Response(JSON.stringify({ success: calls.length === 1, "error-codes": calls.length === 1 ? [] : ["invalid-input-response"] }), { status: 200 });
  };
  try {
    let r = await reg(mail("cap3"), { turnstileToken: "tok-1" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(calls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].body.get("secret"), "secret-xyz");
    assert.equal(calls[0].body.get("response"), "tok-1");
    assert.ok(calls[0].body.get("remoteip"));
    r = await reg(mail("cap4"), { turnstileToken: "tok-2" });
    assert.equal(r.body.error.code, "CAPTCHA_FAILED");
    global.fetch = async () => new Response("oops", { status: 500 });
    r = await reg(mail("cap4"), { turnstileToken: "tok-3" });
    assert.equal(r.status, 503, "HTTP-ошибка Cloudflare = недоступен");
  } finally {
    global.fetch = realFetch;
    env.TURNSTILE_SECRET_KEY = undefined;
  }
});

// ---------- Gmail ----------

test("emailKey: у Gmail без точек и +метки, googlemail = gmail; у остальных адрес как есть", () => {
  assert.equal(emailKey("a.b.c+news@gmail.com"), "abc@gmail.com");
  assert.equal(emailKey("abc@googlemail.com"), "abc@gmail.com");
  assert.equal(emailKey("x.y@example.com"), "x.y@example.com");
  assert.equal(emailKey("x+y@example.com"), "x+y@example.com");
  assert.equal(emailKey("name@notgmail.com"), "name@notgmail.com");
  assert.equal(emailKey("gmail.com@example.com"), "gmail.com@example.com");
  assert.equal(emailKey("+tag@gmail.com"), "+tag@gmail.com", "пустое имя после нормализации — как есть");
});

test("Gmail: варианты одного ящика (точки, +метка, googlemail, регистр) — 409 EMAIL_TAKEN", async () => {
  const first = `Jo.hn${T}+shop@Gmail.com`; // регистр схлопывает zod
  assert.equal((await reg(first)).status, 201);
  assert.equal((await userOf(`jo.hn${T}+shop@gmail.com`)).emailKey, `john${T}@gmail.com`);
  for (const v of [`john${T}@gmail.com`, `j.o.h.n${T}@gmail.com`, `john${T}+other@gmail.com`, `jo.hn${T}@googlemail.com`, `JOHN${T}@GMAIL.COM`]) {
    const r = await reg(v);
    assert.equal(r.status, 409, v);
    assert.equal(r.body.error.code, "EMAIL_TAKEN", v);
  }
  assert.equal(await prisma.user.count({ where: { emailKey: `john${T}@gmail.com` } }), 1);
  // вход по тому адресу, с которым регистрировались, работает
  assert.equal((await api("post", "/auth/login").send({ email: `jo.hn${T}+shop@gmail.com`, password: PASSWORD })).status, 200);
});

test("Gmail: у других почтовых сервисов точки и + значимы — это разные адреса", async () => {
  assert.equal((await reg(mail("pq"))).status, 201);
  assert.equal((await reg(`p.q-${T}@abuse-test.example.com`)).status, 201);
  assert.equal((await reg(mail("pq+tag"))).status, 201);
});

test("Gmail: параллельная регистрация двух вариантов — проходит ровно одна (уникальный индекс)", async () => {
  const [a, b] = await Promise.all([reg(`ra.b${T}@gmail.com`), reg(`rab${T}+x@gmail.com`)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(await prisma.user.count({ where: { emailKey: `rab${T}@gmail.com` } }), 1);
});

test("Gmail: старые дубли (до появления поля) не трогаются и входят как прежде, новые варианты блокируются", async () => {
  const hash = (await reg(mail("seedpw"))).status === 201 ? (await userOf(mail("seedpw"))).passwordHash : null;
  // после миграции у самого раннего из дублей ключ есть, у остальных — NULL
  await prisma.user.create({ data: { email: `ol.d${T}@gmail.com`, emailKey: `old${T}@gmail.com`, passwordHash: hash, displayName: "old1", emailVerifiedAt: new Date() } });
  await prisma.user.create({ data: { email: `old${T}@gmail.com`, emailKey: null, passwordHash: hash, displayName: "old2", emailVerifiedAt: new Date() } });
  for (const e of [`ol.d${T}@gmail.com`, `old${T}@gmail.com`]) {
    assert.equal((await api("post", "/auth/login").send({ email: e, password: PASSWORD })).status, 200, e);
  }
  assert.equal((await reg(`o.l.d${T}+x@gmail.com`)).status, 409);
  assert.equal((await userOf(`old${T}@gmail.com`)).emailKey, null, "существующие записи не менялись");
});

// ---------- глобальный предохранитель ----------

test("предохранитель: после лимита регистраций за час — 429 REGISTRATION_PAUSED с Retry-After, вход и остальное работают", async () => {
  const have = await prisma.user.count({ where: { createdAt: { gt: new Date(Date.now() - 3600000) } } });
  regFuse.limits.perHour = have + 2;
  assert.equal((await reg(mail("f1"))).status, 201);
  assert.equal((await reg(mail("f2"))).status, 201);
  const r = await reg(mail("f3"));
  assert.equal(r.status, 429);
  assert.equal(r.body.error.code, "REGISTRATION_PAUSED");
  const ra = Number(r.headers["retry-after"]);
  assert.ok(ra >= 60 && ra <= 3600, `Retry-After ${ra}`);
  assert.equal(r.body.error.details.retryAfterSeconds, ra);
  assert.equal(await userOf(mail("f3")), null);
  // «окно» сдвигается: самые ранние регистрации старше часа → место освобождается
  assert.equal((await api("post", "/auth/login").send({ email: mail("f1"), password: PASSWORD })).status, 200, "вход не страдает");
  await prisma.user.updateMany({ where: { email: { in: [mail("f1"), mail("f2")] } }, data: { createdAt: new Date(Date.now() - 2 * 3600000) } });
  assert.equal((await reg(mail("f3"))).status, 201);
});

test("предохранитель: админам уходит ровно один пуш за час, сколько бы отказов ни было; потом снова", async () => {
  const have = await prisma.user.count({ where: { createdAt: { gt: new Date(Date.now() - 3600000) } } });
  regFuse.limits.perHour = have; // уже на пределе
  for (let i = 0; i < 4; i++) assert.equal((await reg(mail(`g${i}`))).status, 429);
  await push.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Регистрации приостановлены");
  assert.equal(sent[0].hash, "#/admin/stats");
  assert.match(sent[0].body, new RegExp(`${have}`));
  // через два часа: окно сдвинулось, но свежая регистрация (из «будущего») снова держит сайт на пределе — напоминание
  regFuse.limits.perHour = 1;
  await mkUser("fz", { createdAt: new Date(Date.now() + 90 * 60000) });
  await assert.rejects(regFuse.assertRegistrationOpen(Date.now() + 2 * 3600000), { code: "REGISTRATION_PAUSED" });
  await push.idle();
  assert.equal(sent.length, 2);
});

test("предохранитель: ниже лимита ничего не происходит и пуша нет", async () => {
  const have = await prisma.user.count({ where: { createdAt: { gt: new Date(Date.now() - 3600000) } } });
  regFuse.limits.perHour = have + 5;
  assert.equal((await reg(mail("h1"))).status, 201);
  await push.idle();
  assert.equal(sent.length, 0);
});

// ---------- группировка пушей ----------

test("countText: правильные формы слова", () => {
  assert.equal(batch.countText(1), "1 новое предложение рецепта");
  assert.equal(batch.countText(2), "2 новых предложения рецептов");
  assert.equal(batch.countText(4), "4 новых предложения рецептов");
  assert.equal(batch.countText(5), "5 новых предложений рецептов");
  assert.equal(batch.countText(11), "11 новых предложений рецептов");
  assert.equal(batch.countText(12), "12 новых предложений рецептов");
  assert.equal(batch.countText(21), "21 новое предложение рецепта");
  assert.equal(batch.countText(22), "22 новых предложения рецептов");
  assert.equal(batch.countText(111), "111 новых предложений рецептов");
});

test("пуши предложений: первое уходит сразу, следующие в окне — одним «N новых предложений»", async () => {
  batch.config.windowMs = 10 * 60 * 1000;
  await batch.add({ id: "1", title: "Борщ", author: "Аня", resubmitted: false });
  await push.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Новое предложение рецепта");
  assert.equal(sent[0].body, "«Борщ» — Аня");
  assert.equal(sent[0].tag, "submission-1");

  for (const [i, t] of ["Плов", "Щи", "Суп"].entries()) await batch.add({ id: `b${i}`, title: t, author: "Боб", resubmitted: false });
  await push.idle();
  assert.equal(sent.length, 1, "в окне новых пушей нет");

  await batch.flush();
  await push.idle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, "3 новых предложения рецептов");
  assert.equal(sent[1].body, "«Плов», «Щи», «Суп»");
  assert.equal(sent[1].hash, "#/admin/submissions");
  assert.equal(sent[1].tag, "submissions-batch");
});

test("пуши предложений: одно отложенное уходит в обычном виде; пустой flush ничего не шлёт", async () => {
  batch.config.windowMs = 10 * 60 * 1000;
  await batch.add({ id: "a", title: "Первое", author: "А", resubmitted: false });
  await batch.add({ id: "b", title: "Второе", author: "Б", resubmitted: true });
  await batch.flush();
  await batch.flush();
  await push.idle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, "Исправленное предложение рецепта");
  assert.equal(sent[1].body, "«Второе» — Б");
  assert.equal(sent[1].tag, "submission-b");
});

test("пуши предложений: таймер сам отправляет накопленное по истечении окна", async () => {
  batch.config.windowMs = 250;
  await batch.add({ id: "t1", title: "Раз", author: "А", resubmitted: false });
  await push.idle();
  await batch.add({ id: "t2", title: "Два", author: "А", resubmitted: false });
  await batch.add({ id: "t3", title: "Три", author: "А", resubmitted: false });
  await push.idle();
  assert.equal(sent.length, 1);
  await new Promise((r) => setTimeout(r, 450));
  await push.idle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, "2 новых предложения рецептов");
  // после пачки окно началось заново: следующее предложение сразу не уходит
  await batch.add({ id: "t4", title: "Четыре", author: "А", resubmitted: false });
  await push.idle();
  assert.equal(sent.length, 2);
  await batch.flush();
  await push.idle();
});

test("пуши предложений через API: три отправки подряд — один пуш сразу и один «2 новых»", async () => {
  batch.config.windowMs = 10 * 60 * 1000;
  const users = [await mkUser("p1"), await mkUser("p2"), await mkUser("p3")];
  for (const [i, u] of users.entries()) {
    const r = await as(u, "post", "/me/submissions").send(input({ title: `Рецепт ${i} ${T}` }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await push.idle();
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, `«Рецепт 0 ${T}» — p1`);
  await batch.flush();
  await push.idle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, "2 новых предложения рецептов");
  assert.match(sent[1].body, new RegExp(`Рецепт 1 ${T}.*Рецепт 2 ${T}`));
});

// ---------- аккаунты без действий ----------

test("cleanup: аккаунты старше 30 дней без единого действия удаляются; активные, свежие и админы остаются", async () => {
  const old = (d) => new Date(Date.now() - d * DAY);
  const mk = (n, data) => prisma.user.create({ data: { email: mail(n), passwordHash: "x", displayName: n, emailVerifiedAt: new Date(), ...data } });
  await mk("i-dead", { createdAt: old(31) });
  await mk("i-fresh", { createdAt: old(29) });
  await mk("i-active", { createdAt: old(60), lastActiveAt: old(45) }); // действие было, пусть и давно
  await mk("i-admin", { createdAt: old(60), role: "ADMIN" });
  const dead = await userOf(mail("i-dead"));
  await prisma.favorite.count(); // таблица доступна; личные данные уйдут каскадом
  assert.equal(INACTIVE_TTL_MS, 30 * DAY);

  const r = await cleanup();
  assert.ok(r.inactive >= 1);
  assert.equal(await userOf(mail("i-dead")), null);
  assert.equal(await prisma.refreshToken.count({ where: { userId: dead.id } }), 0);
  for (const n of ["i-fresh", "i-active", "i-admin"]) assert.ok(await userOf(mail(n)), n);
});

test("активность: вход, синхронизация и отправка предложения отмечают аккаунт — cleanup его не трогает", async () => {
  const old = new Date(Date.now() - 40 * DAY);
  for (const n of ["login", "sync", "submit", "nothing"]) {
    assert.equal((await reg(mail(`act-${n}`))).status, 201);
    assert.equal((await userOf(mail(`act-${n}`))).lastActiveAt, null, "сама регистрация действием не считается");
    await prisma.user.update({ where: { email: mail(`act-${n}`) }, data: { createdAt: old, emailVerifiedAt: new Date() } }); // подтверждены: отдельное правило про неподтверждённых тут не мешает
  }
  const tok = async (n) => (await api("post", "/auth/login").send({ email: mail(`act-${n}`), password: PASSWORD })).body.accessToken;
  // login-пользователь вошёл (отметка ставится), остальные получают токен прямым подписыванием, чтобы не отмечаться входом
  assert.ok(await tok("login"));
  for (const n of ["sync", "submit", "nothing"]) {
    const u = await userOf(mail(`act-${n}`));
    assert.equal(u.lastActiveAt, null);
  }
  const bearer = async (n) => ({ id: (await userOf(mail(`act-${n}`))).id, token: signAccessToken(await userOf(mail(`act-${n}`))) });
  const s = await as(await bearer("sync"), "post", "/me/sync").send({ ops: [] });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const sub = await as(await bearer("submit"), "post", "/me/submissions").send(input({ title: `Из активности ${T}` }));
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  await push.idle();
  for (const n of ["login", "sync", "submit"]) assert.ok((await userOf(mail(`act-${n}`))).lastActiveAt, n);
  assert.equal((await userOf(mail("act-nothing"))).lastActiveAt, null);

  await cleanup();
  for (const n of ["login", "sync", "submit"]) assert.ok(await userOf(mail(`act-${n}`)), n);
  assert.equal(await userOf(mail("act-nothing")), null);
});

test("активность: отметка не чаще раза в час (sync вызывается часто)", async () => {
  const u = await mkUser("hourly");
  const row = () => prisma.user.findUnique({ where: { id: u.id }, select: { lastActiveAt: true } });
  const recent = new Date(Date.now() - 10 * 60000);
  await prisma.user.update({ where: { id: u.id }, data: { lastActiveAt: recent } });
  assert.equal((await as(u, "post", "/me/sync").send({ ops: [] })).status, 200);
  assert.equal((await row()).lastActiveAt.getTime(), recent.getTime(), "10 минут назад — не перезаписываем");
  await prisma.user.update({ where: { id: u.id }, data: { lastActiveAt: new Date(Date.now() - 2 * 3600000) } });
  assert.equal((await as(u, "post", "/me/sync").send({ ops: [] })).status, 200);
  assert.ok(Date.now() - (await row()).lastActiveAt.getTime() < 60000, "2 часа назад — обновлено");
});

test("миграция: SQL канонического адреса даёт ключ самому раннему дублю, остальным NULL; все получают отсрочку", async () => {
  const sql = require("node:fs").readFileSync(
    path.join(__dirname, "..", "prisma", "migrations", "20261006180000_abuse_protection", "migration.sql"), "utf8");
  // повторяем только шаги данных на временной таблице — структура уже применена migrate deploy
  const tbl = `mig_${T}`;
  await prisma.$executeRawUnsafe(`CREATE TEMP TABLE ${tbl} (id serial, email text, email_key text, last_active_at timestamp, created_at timestamp)`);
  await prisma.$executeRawUnsafe(`INSERT INTO ${tbl} (email, created_at) VALUES
    ('a.b@gmail.com', '2026-01-01'), ('ab@gmail.com', '2026-02-01'), ('a.b+x@googlemail.com', '2026-03-01'),
    ('c.d@yandex.ru', '2026-01-01'), ('cd@yandex.ru', '2026-01-02'), ('+t@gmail.com', '2026-01-01')`);
  const data = sql
    .split("\n").filter((l) => !l.startsWith("--")).join("\n")
    .replace(/ALTER TABLE[^;]*;/g, "").replace(/CREATE UNIQUE INDEX[^;]*;/g, "")
    .replace(/"users"/g, tbl).replace(/"email_key"/g, "email_key").replace(/"last_active_at"/g, "last_active_at")
    .replace(/"created_at"/g, "created_at").replace(/"id"/g, "id").replace(/"email"/g, "email");
  for (const stmt of data.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(stmt);
  const rows = await prisma.$queryRawUnsafe(`SELECT email, email_key, last_active_at IS NOT NULL AS grace FROM ${tbl} ORDER BY id`);
  assert.deepEqual(rows.map((r) => [r.email, r.email_key]), [
    ["a.b@gmail.com", "ab@gmail.com"],
    ["ab@gmail.com", null],
    ["a.b+x@googlemail.com", null],
    ["c.d@yandex.ru", "c.d@yandex.ru"],
    ["cd@yandex.ru", "cd@yandex.ru"],
    ["+t@gmail.com", "+t@gmail.com"],
  ]);
  assert.ok(rows.every((r) => r.grace));
});
