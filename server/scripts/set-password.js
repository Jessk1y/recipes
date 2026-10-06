// Смена пароля пользователя из консоли (забыл пароль, нет почтового сброса).
// Использование: npm run set-password -- <email>
// Пароль спрашивается в терминале (скрыто, дважды), правила те же, что при регистрации.
// Новый хэш сохраняется, все refresh-токены пользователя отзываются. БД — из DATABASE_URL.
require("dotenv").config();
const authService = require("../src/modules/auth/auth.service");
const schemas = require("../src/modules/auth/auth.schemas");
const prisma = require("../src/lib/prisma");
const { dbUrl, describe } = require("./lib/pgtools");
const { promptHidden } = require("./lib/promptHidden");

const fail = (msg) => {
  console.error(msg);
  process.exitCode = 1;
};

async function main() {
  const emailArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!emailArg) return fail("Использование: npm run set-password -- <email>");
  const email = schemas.register.shape.email.safeParse(emailArg);
  if (!email.success) return fail(email.error.issues[0].message);

  console.log(`БД   ${describe(dbUrl())}\nUser ${email.data}`);
  const password = await promptHidden("Новый пароль: ");
  const parsed = schemas.password.safeParse(password);
  if (!parsed.success) return fail(parsed.error.issues[0].message);
  if ((await promptHidden("Повторите пароль: ")) !== password) return fail("Пароли не совпадают");

  const { user, revoked } = await authService.setPassword(email.data, password);
  console.log(`Пароль для ${user.email} (${user.role}) изменён. Отозвано сессий: ${revoked}.`);
}

main()
  .catch((e) => fail(e.message || e))
  .finally(() => prisma.$disconnect());
