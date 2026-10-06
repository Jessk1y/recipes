// Подписки админов на Web Push. Подписка принадлежит браузеру: endpoint уникален, и если на том же
// устройстве вошёл другой админ, подписка переходит к нему (PUT при открытии админки).
const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const push = require("../../lib/push");
const { AppError } = require("../../lib/errors");

const MAX_PER_USER = 10; // телефон + ноутбук + пара браузеров; старые вытесняются

const assertEnabled = () => {
  if (!env.pushEnabled) throw new AppError(503, "PUSH_DISABLED", "Push-уведомления на сервере не настроены (нет VAPID-ключей)");
};

const key = () => ({ enabled: env.pushEnabled, publicKey: env.pushEnabled ? env.VAPID_PUBLIC_KEY : null });

async function subscribe(userId, { endpoint, keys }) {
  assertEnabled();
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    update: { userId, p256dh: keys.p256dh, auth: keys.auth },
  });
  const all = await prisma.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (all.length > MAX_PER_USER) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: all.slice(MAX_PER_USER).map((s) => s.id) } } });
  }
}

// только свои подписки; повторный вызов безвреден
const unsubscribe = (userId, endpoint) => prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });

// Тестовое уведомление на подписку этого устройства (с ожиданием результата)
async function sendTest(userId, endpoint) {
  assertEnabled();
  const sub = await prisma.pushSubscription.findFirst({ where: { userId, endpoint } });
  if (!sub) throw new AppError(404, "NOT_FOUND", "Подписка не найдена — включите уведомления заново");
  const status = await push.sendTo(
    sub,
    push.serialize({
      title: "Проверка уведомлений",
      body: "Если вы это видите — уведомления работают.",
      hash: "#/admin/submissions",
      tag: "push-test",
    })
  );
  if (status === "gone") throw new AppError(410, "SUBSCRIPTION_GONE", "Подписка устарела и удалена — включите уведомления заново");
  if (status === "failed") throw new AppError(502, "PUSH_FAILED", "Push-сервис браузера не принял уведомление, попробуйте позже");
}

module.exports = { key, subscribe, unsubscribe, sendTest, MAX_PER_USER };
