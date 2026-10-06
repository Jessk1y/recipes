// Проверки e-mail при регистрации: ASCII, одноразовые домены, MX через DNS (DNS подменён). Нужна БД из DATABASE_URL.
process.env.NODE_ENV = "test";
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../src/app");
const prisma = require("../src/lib/prisma");
const emailCheck = require("../src/lib/emailCheck");

const PASS = "correct-horse-1";
const stamp = Date.now();
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const reg = (email) => api("post", "/auth/register").send({ email, password: PASS, confirmPassword: PASS, displayName: "Тест" });

const dnsErr = (code) => Object.assign(new Error(code), { code });
let calls;
// карта домен → ответ resolveMx / (resolve4/resolve6 → пусто, если не задано иное)
function fakeDns({ mx = {}, a = {} } = {}) {
  calls = { mx: 0, a: 0 };
  const pick = (map, d, empty) => {
    const v = map[d];
    if (v instanceof Error) throw v;
    return v ?? empty();
  };
  emailCheck.configure({
    enabled: true,
    resolver: {
      resolveMx: async (d) => { calls.mx++; return pick(mx, d, () => { throw dnsErr("ENOTFOUND"); }); },
      resolve4: async (d) => { calls.a++; return pick(a, d, () => { throw dnsErr("ENODATA"); }); },
      resolve6: async () => { throw dnsErr("ENODATA"); },
    },
  });
}

beforeEach(() => fakeDns({ mx: { "good.test": [{ exchange: "mx.good.test", priority: 10 }] } }));
after(async () => {
  emailCheck.configure({ enabled: false });
  await prisma.user.deleteMany({ where: { email: { startsWith: `chk-${stamp}` } } });
  await prisma.$disconnect();
});

test("только латиница: кириллица в имени или домене → 422 с понятным текстом", async () => {
  for (const email of [`чк-${stamp}@good.test`, `chk-${stamp}@почта.рф`, `chk ${stamp}@good.test`]) {
    const r = await reg(email);
    assert.equal(r.status, 422, email);
    assert.equal(r.body.error.code, "VALIDATION_ERROR");
    assert.match(JSON.stringify(r.body.error.details), /латинск/);
  }
});

test("домен с MX → регистрация проходит", async () => {
  const r = await reg(`chk-${stamp}-ok@good.test`);
  assert.equal(r.status, 201);
});

test("домена нет (ENOTFOUND) → 422 EMAIL_DOMAIN_INVALID, пользователь не создан", async () => {
  const email = `chk-${stamp}-nx@nonexistent.test`;
  const r = await reg(email);
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "EMAIL_DOMAIN_INVALID");
  assert.match(r.body.error.message, /nonexistent\.test/);
  assert.equal(await prisma.user.findUnique({ where: { email } }), null);
});

test("нет MX, но есть A-запись → принимаем (неявный MX по RFC 5321)", async () => {
  fakeDns({ mx: { "web.test": dnsErr("ENODATA") }, a: { "web.test": ["192.0.2.1"] } });
  assert.equal((await reg(`chk-${stamp}-a@web.test`)).status, 201);
});

test("нет ни MX, ни A (ENODATA) → 422", async () => {
  fakeDns({ mx: { "empty.test": dnsErr("ENODATA") } });
  const r = await reg(`chk-${stamp}-e@empty.test`);
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "EMAIL_DOMAIN_INVALID");
});

test("null MX (RFC 7505) → домен явно не принимает почту → 422", async () => {
  fakeDns({ mx: { "nullmx.test": [{ exchange: "", priority: 0 }] }, a: { "nullmx.test": ["192.0.2.1"] } });
  const r = await reg(`chk-${stamp}-n@nullmx.test`);
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "EMAIL_DOMAIN_INVALID");
});

test("сбой DNS (SERVFAIL, таймаут) не блокирует регистрацию", async () => {
  fakeDns({ mx: { "flaky.test": dnsErr("ESERVFAIL"), "slow.test": dnsErr("ETIMEOUT") } });
  assert.equal((await reg(`chk-${stamp}-f1@flaky.test`)).status, 201);
  assert.equal((await reg(`chk-${stamp}-f2@slow.test`)).status, 201);
});

test("зависший DNS обрывается по таймауту и не блокирует регистрацию", async (t) => {
  emailCheck.configure({
    enabled: true,
    resolver: {
      resolveMx: () => new Promise(() => {}),
      resolve4: () => new Promise(() => {}),
      resolve6: () => new Promise(() => {}),
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = emailCheck.mailVerdict("hang.test");
  t.mock.timers.tick(3500);
  assert.equal(await pending, "unknown");
});

test("кэш: повторный домен не гоняет DNS заново; сбой в кэш не попадает", async () => {
  await reg(`chk-${stamp}-c1@good.test`);
  await reg(`chk-${stamp}-c2@good.test`);
  assert.equal(calls.mx, 1);
  fakeDns({ mx: { "flaky.test": dnsErr("ESERVFAIL") } });
  await reg(`chk-${stamp}-c3@flaky.test`);
  await reg(`chk-${stamp}-c4@flaky.test`);
  assert.equal(calls.mx, 2);
});

test("одноразовые домены (и их поддомены) → 422 EMAIL_DISPOSABLE, DNS не опрашивается", async () => {
  for (const email of [`chk-${stamp}@mailinator.com`, `chk-${stamp}@sub.mailinator.com`]) {
    const r = await reg(email);
    assert.equal(r.status, 422, email);
    assert.equal(r.body.error.code, "EMAIL_DISPOSABLE");
  }
  assert.equal(calls.mx, 0);
});

test("обычные домены не считаются одноразовыми", () => {
  for (const d of ["gmail.com", "yandex.ru", "mail.ru", "example.com"]) assert.equal(emailCheck.isDisposable(d), false, d);
});

test("вход и сброс пароля старых пользователей не ходят в DNS", async () => {
  fakeDns(); // любой домен «не существует»
  const r = await api("post", "/auth/login").send({ email: "old-user@legacy-domain.test", password: "whatever-1" });
  assert.equal(r.status, 401); // обычный отказ по паролю, а не 422
  assert.equal(r.body.error.code, "INVALID_CREDENTIALS");
  assert.equal(calls.mx, 0);
});

test("MX в «чёрную дыру» (void.blackhole.mx) → домен не принимает почту, 422", async () => {
  fakeDns({ mx: { "parked.test": [{ exchange: "void.blackhole.mx", priority: 0 }], "mixed.test": [
    { exchange: "void.blackhole.mx", priority: 0 }, { exchange: "mx.mixed.test", priority: 10 }] } });
  const r = await reg(`chk-${stamp}-p@parked.test`);
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "EMAIL_DOMAIN_INVALID");
  // если среди MX есть настоящий — домен рабочий
  assert.equal((await reg(`chk-${stamp}-m@mixed.test`)).status, 201);
});

test("опечатки популярных доменов отклоняются с подсказкой, даже если DNS отвечает", async () => {
  fakeDns({ mx: { "gamil.com": [{ exchange: "mail.gamil.com", priority: 0 }] } }); // сквоттер с живым MX; gmial.com — SERVFAIL
  const cases = { "gmial.com": "gmail.com", "gamil.com": "gmail.com", "gmal.com": "gmail.com", "yandx.ru": "yandex.ru",
    "yadex.ru": "yandex.ru", "mial.ru": "mail.ru", "mai.ru": "mail.ru" };
  for (const [typo, right] of Object.entries(cases)) {
    const r = await reg(`chk-${stamp}-t@${typo}`);
    assert.equal(r.status, 422, typo);
    assert.equal(r.body.error.code, "EMAIL_TYPO");
    assert.equal(r.body.error.message, `Возможно, вы имели в виду chk-${stamp}-t@${right}?`);
  }
  assert.equal(calls.mx, 0); // до DNS не доходим
});

test("настоящие популярные домены не считаются опечатками", () => {
  const { suggestDomain } = require("../src/lib/emailTypos");
  for (const d of ["gmail.com", "mail.ru", "yandex.ru", "ya.ru", "company.org", "good.test"]) assert.equal(suggestDomain(d), null, d);
});
