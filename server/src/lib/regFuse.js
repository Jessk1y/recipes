// Глобальный предохранитель регистраций: если за последний час зарегистрировалось REGISTRATIONS_PER_HOUR человек
// (на весь сайт, не по IP), новые регистрации временно получают 429, а админам уходит push (раз в час, не на каждый отказ).
// Считаем по БД (users.created_at), а не в памяти: бесплатный Render засыпает и перезапускается.
const env = require("../config/env");
const prisma = require("./prisma");
const push = require("./push");
const { AppError } = require("./errors");

const HOUR = 60 * 60 * 1000;
// изменяемый объект: в тестах лимит не мешает остальным наборам, а свои проверки задают его сами
const limits = { perHour: env.NODE_ENV === "test" ? 1_000_000 : env.REGISTRATIONS_PER_HOUR };
let lastAlertAt = 0;

// Бросает 429 REGISTRATION_PAUSED, если лимит исчерпан. Вызывать до тяжёлой работы (bcrypt, DNS).
async function assertRegistrationOpen(now = Date.now()) {
  const since = new Date(now - HOUR);
  const count = await prisma.user.count({ where: { createdAt: { gt: since } } });
  if (count < limits.perHour) return;

  // когда освободится место: истечёт час у (count − лимит + 1)-й по возрасту регистрации
  const [edge] = await prisma.user.findMany({
    where: { createdAt: { gt: since } },
    orderBy: { createdAt: "asc" },
    skip: count - limits.perHour,
    take: 1,
    select: { createdAt: true },
  });
  const retryAfter = Math.max(60, Math.ceil((edge.createdAt.getTime() + HOUR - now) / 1000));

  if (now - lastAlertAt >= HOUR) {
    lastAlertAt = now;
    push.background(() =>
      push.notifyAdmins({
        title: "Регистрации приостановлены",
        body: `За последний час ${count} новых аккаунтов (лимит ${limits.perHour}). Похоже на массовую регистрацию — проверьте «Статистику».`,
        hash: "#/admin/stats",
        tag: "registration-fuse",
      })
    );
  }
  const err = new AppError(429, "REGISTRATION_PAUSED", "Регистрация временно приостановлена из-за большого числа заявок. Попробуйте позже.", {
    retryAfterSeconds: retryAfter,
  });
  err.headers = { "Retry-After": String(retryAfter) };
  throw err;
}

module.exports = { assertRegistrationOpen, limits, resetAlert: () => { lastAlertAt = 0; } };
