// Лимиты авторизации: /refresh и /me — только общий лимит API; вход — строго по паре IP+e-mail
// и мягко по IP; регистрация — по IP. Все запросы supertest идут с одного IP — как студенты за общим Wi-Fi.
process.env.NODE_ENV = "test";
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcrypt");
const app = require("../src/app");
const prisma = require("../src/lib/prisma");
const limiters = require("../src/middleware/rateLimits");

const T = `al${Date.now().toString(36)}`;
const PASSWORD = "correct-horse-1";
const mail = (n) => `${n}-${T}@limits-test.example.com`;
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const login = (email, password = PASSWORD) => api("post", "/auth/login").send({ email, password });

// боевые значения лимитов (в тестах по умолчанию они «бесконечные»)
const PROD = { global: 3000, write: 150, sync: 1500, view: 600, loginPair: 10, loginIp: 200, register: 50 };
const LOOSE = 1_000_000;
function useProdLimits(over = {}) {
  for (const [k, v] of Object.entries({ ...PROD, ...over })) limiters.limits[k].limit = v;
}

let hash;
const USERS = 40;
beforeEach(() => limiters.resetAll());
after(async () => {
  for (const k of Object.keys(PROD)) limiters.limits[k].limit = LOOSE;
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${T}@limits-test.example.com` } } });
  await prisma.$disconnect();
});

async function mkUsers(n) {
  hash ??= bcrypt.hashSync(PASSWORD, 4);
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${T}@limits-test.example.com` } } }); // свежий набор в каждом тесте
  await prisma.user.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      email: mail(`u${i}`), passwordHash: hash, displayName: `U${i}`, emailVerifiedAt: new Date(),
    })),
  });
}

test("40 разных пользователей с одного IP входят и обновляют токен — без 429 при боевых лимитах", async () => {
  await mkUsers(USERS);
  useProdLimits({ write: 5 }); // write занижен: вход и refresh его расходовать не должны
  try {
    const sessions = [];
    for (let i = 0; i < USERS; i++) {
      const r = await login(mail(`u${i}`));
      assert.equal(r.status, 200, `login #${i}`);
      sessions.push(r.body);
    }
    for (let i = 0; i < USERS; i++) {
      const r = await api("post", "/auth/refresh").send({ refreshToken: sessions[i].refreshToken });
      assert.equal(r.status, 200, `refresh #${i}`);
      const me = await api("get", "/auth/me").set("Authorization", `Bearer ${r.body.accessToken}`);
      assert.equal(me.status, 200, `me #${i}`);
      assert.equal(me.body.email, mail(`u${i}`));
      sessions[i] = { ...sessions[i], accessToken: r.body.accessToken };
    }
    // обычная работа каждого: каталог/настройки, несколько sync и просмотров (~12 запросов на человека)
    for (let i = 0; i < USERS; i++) {
      const bearer = `Bearer ${sessions[i].accessToken}`;
      for (const url of ["/config", "/catalog/snapshot", "/categories"]) {
        assert.equal((await api("get", url)).status, 200, `${url} #${i}`);
      }
      for (let k = 0; k < 3; k++) {
        const op = { type: "favorite.add", slug: `no-such-recipe-${k}`, at: new Date().toISOString() };
        const s = await api("post", "/me/sync").set("Authorization", bearer).send({ ops: [op] });
        assert.equal(s.status, 200, `sync #${i}/${k}`);
        const v = await api("post", "/stats/view").send({ slug: `no-such-recipe-${k}` });
        assert.notEqual(v.status, 429, `view #${i}/${k}`);
      }
    }
  } finally {
    useProdLimits(Object.fromEntries(Object.keys(PROD).map((k) => [k, LOOSE])));
  }
});

test("login: подбор пароля к одному аккаунту режется (429), другой аккаунт с того же IP не страдает", async () => {
  await mkUsers(2);
  limiters.limits.loginPair.limit = 3;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await login(mail("u0"), "wrong-password")).status, 401);
    const over = await login(mail("u0"), "wrong-password");
    assert.equal(over.status, 429);
    assert.equal(over.body.error.code, "RATE_LIMITED");
    // регистр e-mail не позволяет обойти ключ
    assert.equal((await login(mail("u0").toUpperCase(), "wrong-password")).status, 429);
    assert.equal((await login(mail("u1"))).status, 200);
  } finally {
    limiters.limits.loginPair.limit = LOOSE;
  }
});

test("login: успешные входы в лимит пары не засчитываются", async () => {
  await mkUsers(1);
  limiters.limits.loginPair.limit = 2;
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login(mail("u0"))).status, 200);
    assert.equal((await login(mail("u0"), "wrong-password")).status, 401);
  } finally {
    limiters.limits.loginPair.limit = LOOSE;
  }
});

test("login: мягкий лимит по IP режет вход, но не refresh и /me", async () => {
  await mkUsers(1);
  const first = await login(mail("u0"));
  limiters.limits.loginIp.limit = 3;
  try {
    for (let i = 0; i < 2; i++) assert.equal((await login(mail("u0"))).status, 200);
    assert.equal((await login(mail("u0"))).status, 429);
    const r = await api("post", "/auth/refresh").send({ refreshToken: first.body.refreshToken });
    assert.equal(r.status, 200);
    assert.equal((await api("get", "/auth/me").set("Authorization", `Bearer ${r.body.accessToken}`)).status, 200);
  } finally {
    limiters.limits.loginIp.limit = LOOSE;
  }
});

test("register: лимит по IP", async () => {
  limiters.limits.register.limit = 2;
  try {
    for (let i = 0; i < 2; i++) assert.equal((await api("post", "/auth/register").send({})).status, 422);
    const over = await api("post", "/auth/register").send({});
    assert.equal(over.status, 429);
    assert.equal(over.body.error.code, "RATE_LIMITED");
  } finally {
    limiters.limits.register.limit = LOOSE;
  }
});

test("refresh и /me остаются под общим лимитом API", async () => {
  limiters.limits.global.limit = 2;
  try {
    for (let i = 0; i < 2; i++) assert.equal((await api("post", "/auth/refresh").send({ refreshToken: "x" })).status, 401);
    assert.equal((await api("post", "/auth/refresh").send({ refreshToken: "x" })).status, 429);
  } finally {
    limiters.limits.global.limit = LOOSE;
  }
});
