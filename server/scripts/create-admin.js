// Создание (или повышение до ADMIN) пользователя из консоли — публичного API для этого нет.
// Использование: npm run create-admin -- <email> <пароль> [имя]
require("dotenv").config();
const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");
const { emailKey } = require("../src/lib/emailKey");

const prisma = new PrismaClient();

async function main() {
  const [emailArg, password, displayName = "Администратор"] = process.argv.slice(2);
  if (!emailArg || !password) {
    console.error("Использование: npm run create-admin -- <email> <пароль> [имя]");
    process.exit(1);
  }
  if (password.length < 8 || password.length > 72) {
    console.error("Пароль: от 8 до 72 символов");
    process.exit(1);
  }
  const email = emailArg.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { role: "ADMIN", passwordHash, isBlocked: false },
    create: { email, emailKey: emailKey(email), passwordHash, displayName, role: "ADMIN" },
  });
  console.log(`Администратор: ${user.email} (${user.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
