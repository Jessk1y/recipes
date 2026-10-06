// Периодическая чистка: неподтверждённые аккаунты старше 7 дней, отработавшие токены из писем,
// отклонённые предложения рецептов без правок 30 дней (вместе с фото).
// Администраторов не трогаем. Связанные данные пользователя удаляются каскадом, рецепты остаются (author → null).
const prisma = require("./prisma");
const env = require("../config/env");
const { releaseImage } = require("../modules/recipes/recipes.service");
const logger = require("./logger");

const DAY = 24 * 60 * 60 * 1000;
const UNVERIFIED_TTL_MS = 7 * DAY;
const REJECTED_TTL_MS = 30 * DAY;

async function cleanup(now = new Date()) {
  // при отключённой почте подтвердить e-mail нельзя — неподтверждённых не удаляем
  const users = env.mailEnabled
    ? await prisma.user.deleteMany({
        where: { emailVerifiedAt: null, role: "USER", createdAt: { lt: new Date(now.getTime() - UNVERIFIED_TTL_MS) } },
      })
    : { count: 0 };
  // токены, которые уже нельзя использовать, храним ещё сутки (для разбора жалоб), затем удаляем
  const old = new Date(now.getTime() - DAY);
  const tokens = await prisma.emailToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: old } }, { usedAt: { lt: old } }] },
  });
  // отклонённые предложения, которые автор не правил 30 дней (updatedAt меняется при отказе и при правке), — вместе с фото
  const stale = await prisma.recipe.findMany({
    where: { status: "REJECTED", submittedAt: { not: null }, updatedAt: { lt: new Date(now.getTime() - REJECTED_TTL_MS) } },
    select: { id: true, image: true },
  });
  if (stale.length) await prisma.recipe.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
  for (const r of stale) await releaseImage(r.image);
  return { users: users.count, tokens: tokens.count, rejected: stale.length };
}

// Запуск при старте (бесплатный Render часто засыпает, поэтому одного таймера мало) и раз в 6 часов
function schedule() {
  const run = () =>
    cleanup()
      .then((r) => (r.users || r.tokens || r.rejected) && logger.info(r, "очистка: удалены неподтверждённые аккаунты, старые токены и отклонённые предложения"))
      .catch((err) => logger.error({ err: err.message }, "очистка не удалась"));
  setTimeout(run, 30_000).unref();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}

module.exports = { cleanup, schedule, UNVERIFIED_TTL_MS, REJECTED_TTL_MS };
