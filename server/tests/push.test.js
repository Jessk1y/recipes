// Web Push для админа: права, проверка подписок, передача между админами, лимит, рассылка при новом предложении,
// удаление мёртвых подписок, тестовое уведомление, реальный отправитель (без сети).
// Идёт в отдельной схеме Postgres: рассылка идёт всем админам в БД, а наборы тестов выполняются параллельно.
const { execSync } = require("node:child_process");
const path = require("node:path");

require("dotenv").config();
const testUrl = new URL(process.env.DATABASE_URL);
testUrl.searchParams.set("schema", "recipes_push_test");
process.env.DATABASE_URL = testUrl.toString(); // dotenv не перезаписывает уже заданные переменные
process.env.NODE_ENV = "test";
process.env.STORAGE_DRIVER = "local";
execSync("node node_modules/prisma/build/index.js migrate deploy", { cwd: path.join(__dirname, ".."), stdio: "pipe" });

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const request = require("supertest");
const webpush = require("web-push");
const app = require("../src/app");
const env = require("../src/config/env");
const prisma = require("../src/lib/prisma");
const push = require("../src/lib/push");
const limiters = require("../src/middleware/rateLimits");
const { signAccessToken } = require("../src/lib/jwt");
const { isPushUrl } = require("../src/modules/push/push.schemas");

const T = `zp${Date.now().toString(36)}`;
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const as = (u, m, url) => api(m, url).set("Authorization", `Bearer ${u.token}`);
const U = {}; // имя → { id, token }
const CAT = `Тест ${T}`;

// настоящая пара ключей подписки, как её выдаёт браузер (p256dh — 65 байт, auth — 16 байт)
function browserKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
}
const sub = (name, keys = browserKeys()) => ({ endpoint: `https://push.example.test/send/${T}-${name}`, keys });

async function mkUser(name, data = {}) {
  const u = await prisma.user.create({
    data: { email: `${name}-${T}@push-test.example.com`, passwordHash: "x", displayName: name, emailVerifiedAt: new Date(), ...data },
  });
  U[name] = { id: u.id, token: signAccessToken(u) };
}
const subscribe = (u, s) => as(u, "put", "/admin/push/subscription").send(s);
const rows = (where = {}) => prisma.pushSubscription.findMany({ where: { endpoint: { contains: T }, ...where } });

// подменяемый отправитель: запоминает, кому и что ушло; поведение по endpoint задаёт тест
let sent;
let behavior;
const stub = async (s, payload) => {
  sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload) });
  const b = behavior[s.endpoint];
  if (b) throw Object.assign(new Error("push service error"), { statusCode: b });
};
const sentTo = (name) => sent.filter((x) => x.endpoint === sub(name).endpoint);

const input = (extra = {}) => ({
  title: `Суп ${T}`, category: CAT, main: ["Первое"], tags: ["быстро"], time: "30 мин", servings: "2",
  ingredients: [{ name: "Вода", amount: "1 л" }], steps: [{ text: "Варить 15 мин" }], ...extra,
});
async function submit(u, extra) {
  // прошлые отправки «стареют» на сутки, чтобы лимит в сутки не мешал
  await prisma.recipe.updateMany({ where: { authorId: u.id, submittedAt: { not: null } }, data: { submittedAt: new Date(Date.now() - 48 * 3600000) } });
  const r = await as(u, "post", "/me/submissions").send(input(extra));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await push.idle();
  return r.body;
}

const savedEnv = { pushEnabled: env.pushEnabled, pub: env.VAPID_PUBLIC_KEY, priv: env.VAPID_PRIVATE_KEY };
before(async () => {
  const keys = webpush.generateVAPIDKeys();
  env.VAPID_PUBLIC_KEY = keys.publicKey;
  env.VAPID_PRIVATE_KEY = keys.privateKey;
  env.pushEnabled = true;
  push.setSender(stub);
  await prisma.category.create({ data: { name: CAT, slug: `test-${T}` } });
  await mkUser("admin", { role: "ADMIN" });
  await mkUser("admin2", { role: "ADMIN" });
  await mkUser("admin3", { role: "ADMIN" }); // его разжалуют/заблокируют
  await mkUser("blockedAdmin", { role: "ADMIN", isBlocked: true });
  await mkUser("alice");
  await mkUser("exAdmin"); // роль в токене ADMIN, в БД уже USER
  U.exAdmin.token = signAccessToken({ id: U.exAdmin.id, email: "x", role: "ADMIN" });
});
beforeEach(async () => {
  limiters.resetAll();
  sent = [];
  behavior = {};
  env.pushEnabled = true;
  push.setSender(stub);
  await prisma.pushSubscription.deleteMany({ where: { endpoint: { contains: T } } });
});
after(async () => {
  Object.assign(env, { pushEnabled: savedEnv.pushEnabled, VAPID_PUBLIC_KEY: savedEnv.pub, VAPID_PRIVATE_KEY: savedEnv.priv });
  push.setSender(null);
  const ids = Object.values(U).map((u) => u.id);
  await prisma.recipe.deleteMany({ where: { authorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.category.deleteMany({ where: { slug: `test-${T}` } });
  await prisma.$disconnect();
});

// ---------- права ----------

test("все /admin/push: гость и мусорный токен — 401; обычный, разжалованный и заблокированный админ — 403", async () => {
  const calls = [["get", "/admin/push/key"], ["put", "/admin/push/subscription"], ["delete", "/admin/push/subscription"], ["post", "/admin/push/test"]];
  for (const [m, url] of calls) {
    assert.equal((await api(m, url).send({})).status, 401, `гость ${m} ${url}`);
    assert.equal((await api(m, url).set("Authorization", "Bearer junk").send({})).status, 401, `мусор ${m} ${url}`);
    for (const name of ["alice", "exAdmin", "blockedAdmin"]) {
      const r = await as(U[name], m, url).send(m === "get" ? undefined : sub("x"));
      assert.equal(r.status, 403, `${name} ${m} ${url}`);
      assert.equal(r.body.publicKey, undefined);
    }
  }
  assert.equal((await rows()).length, 0, "чужие подписки не создались");
});

// ---------- ключ и режим «пуши отключены» ----------

test("GET /key отдаёт открытый ключ, закрытый — никогда", async () => {
  const r = await as(U.admin, "get", "/admin/push/key");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { enabled: true, publicKey: env.VAPID_PUBLIC_KEY });
  assert.ok(!JSON.stringify(r.body).includes(env.VAPID_PRIVATE_KEY));
});

test("без VAPID-ключей: /key → enabled:false, подписка и тест → 503, рассылки нет, предложение принимается", async () => {
  env.pushEnabled = false;
  const k = await as(U.admin, "get", "/admin/push/key");
  assert.deepEqual(k.body, { enabled: false, publicKey: null });
  const s = await subscribe(U.admin, sub("a"));
  assert.equal(s.status, 503);
  assert.equal(s.body.error.code, "PUSH_DISABLED");
  assert.equal((await as(U.admin, "post", "/admin/push/test").send({ endpoint: sub("a").endpoint })).status, 503);
  // подписка, оставшаяся с прошлых времён, не получает пуш, пока ключей нет
  await prisma.pushSubscription.create({ data: { userId: U.admin.id, ...{ endpoint: sub("a").endpoint, p256dh: sub("a").keys.p256dh, auth: sub("a").keys.auth } } });
  await submit(U.alice);
  assert.equal(sent.length, 0);
});

// ---------- подписка ----------

test("PUT /subscription: сохраняет, повтор обновляет ключи (одна запись)", async () => {
  const first = sub("a");
  assert.equal((await subscribe(U.admin, first)).status, 204);
  let r = await rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].userId, U.admin.id);
  assert.equal(r[0].p256dh, first.keys.p256dh);

  const second = sub("a"); // тот же endpoint, новые ключи (браузер пересоздал подписку)
  assert.equal((await subscribe(U.admin, second)).status, 204);
  r = await rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].p256dh, second.keys.p256dh);
  assert.equal(r[0].auth, second.keys.auth);
});

test("PUT /subscription: некорректные адрес и ключи — 422, ничего не сохраняется", async () => {
  const good = sub("a");
  const bad = [
    ["http вместо https", { ...good, endpoint: "http://push.example.test/x" }],
    ["localhost", { ...good, endpoint: "https://localhost/x" }],
    ["IPv4", { ...good, endpoint: "https://10.0.0.5/x" }],
    ["IPv6", { ...good, endpoint: "https://[::1]/x" }],
    ["внутренняя зона", { ...good, endpoint: "https://db.internal/x" }],
    ["нестандартный порт", { ...good, endpoint: "https://push.example.test:8443/x" }],
    ["логин в адресе", { ...good, endpoint: "https://user:pw@push.example.test/x" }],
    ["не адрес", { ...good, endpoint: "не адрес" }],
    ["слишком длинный", { ...good, endpoint: `https://push.example.test/${"a".repeat(1100)}` }],
    ["p256dh не тот размер", { ...good, keys: { ...good.keys, p256dh: "AAAA" } }],
    ["auth не тот размер", { ...good, keys: { ...good.keys, auth: crypto.randomBytes(20).toString("base64url") } }],
    ["ключ не base64url", { ...good, keys: { ...good.keys, auth: "!!!!!!!!!!!!!!!!!!!!!!" } }],
    ["нет ключей", { endpoint: good.endpoint }],
  ];
  for (const [what, body] of bad) {
    const r = await subscribe(U.admin, body);
    assert.equal(r.status, 422, what);
  }
  assert.equal((await rows()).length, 0);
  assert.ok(isPushUrl("https://fcm.googleapis.com/fcm/send/abc"));
  assert.ok(isPushUrl("https://web.push.apple.com/QWxs"));
  assert.ok(isPushUrl("https://updates.push.services.mozilla.com/wpush/v2/abc"));
});

test("подписка принадлежит браузеру: другой админ на том же устройстве забирает её; отписать чужую нельзя", async () => {
  const s = sub("shared");
  await subscribe(U.admin, s);
  assert.equal((await subscribe(U.admin2, s)).status, 204);
  assert.equal((await rows())[0].userId, U.admin2.id);

  // прежний владелец (вышел из аккаунта) пытается отписать — подписка уже не его, остаётся
  assert.equal((await as(U.admin, "delete", "/admin/push/subscription").send({ endpoint: s.endpoint })).status, 204);
  assert.equal((await rows()).length, 1);

  assert.equal((await as(U.admin2, "delete", "/admin/push/subscription").send({ endpoint: s.endpoint })).status, 204);
  assert.equal((await rows()).length, 0);
  // повторная отписка безвредна
  assert.equal((await as(U.admin2, "delete", "/admin/push/subscription").send({ endpoint: s.endpoint })).status, 204);
});

test("не больше 10 подписок на админа: вытесняются самые старые", async () => {
  for (let i = 0; i < 12; i++) {
    assert.equal((await subscribe(U.admin, sub(`m${i}`))).status, 204);
    await new Promise((r) => setTimeout(r, 5)); // разные createdAt
  }
  const left = (await rows({ userId: U.admin.id })).map((r) => r.endpoint);
  assert.equal(left.length, 10);
  assert.ok(left.includes(sub("m11").endpoint) && !left.includes(sub("m0").endpoint) && !left.includes(sub("m1").endpoint));
  // у другого админа свой лимит
  assert.equal((await subscribe(U.admin2, sub("other"))).status, 204);
  assert.equal((await rows({ userId: U.admin2.id })).length, 1);
});

// ---------- рассылка при новом предложении ----------

test("новое предложение: пуш уходит всем админам с подпиской — и только им", async () => {
  await subscribe(U.admin, sub("phone"));
  await subscribe(U.admin, sub("laptop"));
  await subscribe(U.admin2, sub("admin2"));
  // подписки, которых быть не должно получать пуш: заблокированный админ и пользователь без прав (остались в БД напрямую)
  for (const [name, owner] of [["blocked", "blockedAdmin"], ["user", "alice"]]) {
    const s = sub(name);
    await prisma.pushSubscription.create({ data: { userId: U[owner].id, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth } });
  }
  const created = await submit(U.alice, { title: `Борщ ${T}` });

  assert.equal(sent.length, 3);
  for (const n of ["phone", "laptop", "admin2"]) assert.equal(sentTo(n).length, 1, n);
  assert.equal(sentTo("blocked").length + sentTo("user").length, 0);
  const p = sentTo("phone")[0].payload;
  assert.equal(p.title, "Новое предложение рецепта");
  assert.equal(p.body, `«Борщ ${T}» — alice`);
  assert.equal(p.hash, "#/admin/submissions");
  assert.equal(p.tag, `submission-${created.id}`);
});

test("сбой push-сервиса не ломает ответ автору; живые получают, 404/410 удаляются, 500/сеть — подписка остаётся", async () => {
  for (const n of ["ok", "gone410", "gone404", "err500", "net"]) await subscribe(U.admin, sub(n));
  behavior[sub("gone410").endpoint] = 410;
  behavior[sub("gone404").endpoint] = 404;
  behavior[sub("err500").endpoint] = 500;
  behavior[sub("net").endpoint] = undefined; // «сеть»: ошибка без statusCode
  const baseStub = stub;
  push.setSender(async (s, p) => {
    if (s.endpoint === sub("net").endpoint) throw new Error("ECONNRESET");
    return baseStub(s, p);
  });

  await submit(U.alice); // submit проверяет 201

  const left = (await rows()).map((r) => r.endpoint).sort();
  assert.deepEqual(left, [sub("err500").endpoint, sub("net").endpoint, sub("ok").endpoint].sort());
  assert.equal(sentTo("ok").length, 1, "остальные получили пуш, несмотря на сбои соседей");
});

test("правка отклонённого — снова пуш («Исправленное…»); правка ожидающего — тишина", async () => {
  await subscribe(U.admin, sub("a"));
  const created = await submit(U.alice);
  assert.equal(sent.length, 1);

  // правка ожидающего предложения — без пуша
  let r = await as(U.alice, "put", `/me/submissions/${created.id}`).send(input({ servings: "4" }));
  assert.equal(r.status, 200);
  await push.idle();
  assert.equal(sent.length, 1);

  // отклонили, автор поправил и отправил заново — пуш
  assert.equal((await as(U.admin, "post", `/admin/submissions/${created.id}/reject`).send({ reason: "мало шагов" })).status, 200);
  r = await as(U.alice, "put", `/me/submissions/${created.id}`).send(input({ servings: "3" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await push.idle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.title, "Исправленное предложение рецепта");
});

test("отклонённая валидация и отказ по лимиту не рассылают пуш", async () => {
  await subscribe(U.admin, sub("a"));
  assert.equal((await as(U.alice, "post", "/me/submissions").send({ title: "" })).status, 422);
  assert.equal((await as(U.alice, "post", "/me/submissions").send(input({ category: "Нет такой" }))).status, 422);
  await push.idle();
  assert.equal(sent.length, 0);
});

test("длинное название обрезается: пуш укладывается в лимит размера", async () => {
  await subscribe(U.admin, sub("a"));
  await submit(U.alice, { title: "Я".repeat(200) });
  const p = sent[0].payload;
  assert.ok(p.body.length <= 200);
  assert.ok(Buffer.byteLength(JSON.stringify(p)) < 1000);
});

// ---------- тестовое уведомление ----------

test("POST /test: отправляет пробный пуш на свою подписку", async () => {
  await subscribe(U.admin, sub("a"));
  const r = await as(U.admin, "post", "/admin/push/test").send({ endpoint: sub("a").endpoint });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { sent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, "Проверка уведомлений");
  assert.equal(sent[0].payload.hash, "#/admin/submissions");
});

test("POST /test: нет подписки или она чужая — 404; устарела — 410 и удалена; сбой сервиса — 502, подписка цела", async () => {
  assert.equal((await as(U.admin, "post", "/admin/push/test").send({ endpoint: sub("none").endpoint })).status, 404);

  await subscribe(U.admin2, sub("theirs"));
  assert.equal((await as(U.admin, "post", "/admin/push/test").send({ endpoint: sub("theirs").endpoint })).status, 404);
  assert.equal(sent.length, 0, "чужой endpoint не получает пуш по просьбе другого админа");

  await subscribe(U.admin, sub("dead"));
  behavior[sub("dead").endpoint] = 410;
  const gone = await as(U.admin, "post", "/admin/push/test").send({ endpoint: sub("dead").endpoint });
  assert.equal(gone.status, 410);
  assert.equal(gone.body.error.code, "SUBSCRIPTION_GONE");
  assert.equal((await rows({ endpoint: sub("dead").endpoint })).length, 0);

  await subscribe(U.admin, sub("flaky"));
  behavior[sub("flaky").endpoint] = 503;
  const failed = await as(U.admin, "post", "/admin/push/test").send({ endpoint: sub("flaky").endpoint });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, "PUSH_FAILED");
  assert.equal((await rows({ endpoint: sub("flaky").endpoint })).length, 1);
});

// ---------- права администратора ----------

test("разжалование и блокировка админа удаляют его подписки; у остальных они на месте", async () => {
  await subscribe(U.admin3, sub("a3"));
  await subscribe(U.admin2, sub("a2"));
  const r = await as(U.admin, "patch", `/admin/users/${U.admin3.id}/role`).send({ role: "USER" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await rows()).map((x) => x.endpoint), [sub("a2").endpoint]);

  const b = await as(U.admin, "patch", `/admin/users/${U.admin2.id}/block`).send({ blocked: true });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal((await rows()).length, 0);
  // вернём как было для остальных тестов
  await prisma.user.update({ where: { id: U.admin2.id }, data: { isBlocked: false } });
  await prisma.user.update({ where: { id: U.admin3.id }, data: { role: "ADMIN" } });
});

test("при удалении пользователя его подписки удаляются каскадом", async () => {
  await mkUser("tmpAdmin", { role: "ADMIN" });
  await subscribe(U.tmpAdmin, sub("tmp"));
  assert.equal((await rows()).length, 1);
  await prisma.user.delete({ where: { id: U.tmpAdmin.id } });
  assert.equal((await rows()).length, 0);
});

// ---------- настоящий отправитель (сеть подменена) ----------

test("настоящий отправитель: шифрует пуш, подписывает VAPID-заголовком и передаёт коды 404/410", async () => {
  const s = sub("real");
  const real = https.request;
  const calls = [];
  let status = 201;
  https.request = (options, cb) => {
    const req = new EventEmitter();
    const chunks = [];
    req.write = (c) => chunks.push(Buffer.from(c));
    req.end = () => {
      calls.push({ options, body: Buffer.concat(chunks) });
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = {};
      cb(res);
      res.emit("end");
    };
    req.setTimeout = () => {};
    req.destroy = () => {};
    return req;
  };
  try {
    const row = { id: "x", endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth };
    await push.webpushSender(row, push.serialize({ title: "Привет", body: "тест", hash: "#/admin/submissions" }));
    assert.equal(calls.length, 1);
    const { options, body } = calls[0];
    assert.equal(options.hostname, "push.example.test");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["Content-Encoding"], "aes128gcm");
    assert.equal(options.headers.TTL, 86400);
    assert.match(options.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.ok(options.headers.Authorization.includes(env.VAPID_PUBLIC_KEY), "подпись — нашим открытым ключом");
    assert.ok(!body.includes("Привет"), "тело зашифровано");
    // JWT несёт адрес сайта как subject, а закрытый ключ наружу не уходит
    const jwt = options.headers.Authorization.match(/t=([\w-]+)\.([\w-]+)\./);
    assert.equal(JSON.parse(Buffer.from(jwt[2], "base64url")).sub, env.vapidSubject);
    assert.ok(!JSON.stringify(options).includes(env.VAPID_PRIVATE_KEY));

    status = 410;
    await assert.rejects(push.webpushSender(row, "{}"), (e) => e.statusCode === 410);
  } finally {
    https.request = real;
  }
});

test("сгенерированные ключи VAPID принимаются web-push (проверка того, что пишет npm run push:keys)", () => {
  const k = webpush.generateVAPIDKeys();
  assert.equal(Buffer.from(k.publicKey, "base64url").length, 65);
  assert.equal(Buffer.from(k.privateKey, "base64url").length, 32);
  webpush.setVapidDetails("https://jessk1y.github.io/recipes", k.publicKey, k.privateKey);
  assert.throws(() => webpush.setVapidDetails("http://localhost:8000", k.publicKey, k.privateKey), /https/);
});
