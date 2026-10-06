// set-password: смена пароля из консоли — новый хэш, отзыв всех refresh-токенов, те же правила пароля, что у регистрации.
process.env.NODE_ENV = "test";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const prisma = require("../src/lib/prisma");
const auth = require("../src/modules/auth/auth.service");
const schemas = require("../src/modules/auth/auth.schemas");

const T = `zz${Date.now().toString(36)}`;
const email = `setpw-${T}@example.com`;

after(async () => {
  await prisma.user.deleteMany({ where: { email } }); // refresh-токены удаляются каскадом
  await prisma.$disconnect();
});

test("setPassword меняет пароль и отзывает все сессии пользователя", async () => {
  const s1 = await auth.register({ email, password: "old-password-1", displayName: "Тест" });
  const s2 = await auth.login({ email, password: "old-password-1" });

  const res = await auth.setPassword(email, "new-password-2");
  assert.equal(res.revoked, 2);

  await assert.rejects(auth.login({ email, password: "old-password-1" }), { code: "INVALID_CREDENTIALS" });
  await auth.login({ email, password: "new-password-2" });
  for (const s of [s1, s2]) {
    await assert.rejects(auth.refresh({ refreshToken: s.refreshToken }), { code: "TOKEN_REUSED" });
  }
});

test("setPassword для неизвестного e-mail — USER_NOT_FOUND", async () => {
  await assert.rejects(auth.setPassword(`none-${T}@example.com`, "new-password-2"), { code: "USER_NOT_FOUND" });
});

test("правило пароля то же, что при регистрации", () => {
  assert.equal(schemas.password.safeParse("1234567").success, false);
  assert.equal(schemas.password.safeParse("a".repeat(73)).success, false);
  assert.equal(schemas.password.safeParse("12345678").success, true);
});

test("скрипт без аргумента и без TTY завершается с ошибкой, ничего не меняя", () => {
  const script = path.join(__dirname, "..", "scripts", "set-password.js");
  const noArg = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(noArg.status, 1);
  assert.match(noArg.stderr, /Использование/);
  const noTty = spawnSync(process.execPath, [script, email], { encoding: "utf8", input: "" });
  assert.equal(noTty.status, 1);
  assert.match(noTty.stderr, /интерактивном терминале/);
});
