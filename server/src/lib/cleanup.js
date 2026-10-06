// Периодическая чистка: неподтверждённые аккаунты старше 7 дней и отработавшие токены из писем.
// Администраторов не трогаем. Связанные данные пользователя удаляются каскадом, рецепты остаются (author → null).
const prisma = require("./prisma");
const logger = require("./logger");

const DAY = 24 * 60 * 60 * 1000;
const UNVERIFIED_TTL_MS = 7 * DAY;

async function cleanup(now = new Date()) {
  const users = await prisma.user.deleteMany({
    where: { emailVerifiedAt: null, role: "USER", createdAt: { lt: new Date(now.getTime() - UNVERIFIED_TTL_MS) } },
  });
  // токены, которые уже нельзя использовать, храним ещё сутки (для разбора жалоб), затем удаляем
  const old = new Date(now.getTime() - DAY);
  const tokens = await prisma.emailToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: old } }, { usedAt: { lt: old } }] },
  });
  return { users: users.count, tokens: tokens.count };
}

// Запуск при старте (бесплатный Render часто засыпает, поэтому одного таймера мало) и раз в 6 часов
function schedule() {
  const run = () =>
    cleanup()
      .then((r) => (r.users || r.tokens) && logger.info(r, "очистка: удалены неподтверждённые аккаунты и старые токены"))
      .catch((err) => logger.error({ err: err.message }, "очистка не удалась"));
  setTimeout(run, 30_000).unref();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}

module.exports = { cleanup, schedule, UNVERIFIED_TTL_MS };
