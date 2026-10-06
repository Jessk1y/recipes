// Web Push для администраторов: отправка уведомлений на подписанные браузеры.
// Ключи VAPID — в config/env.js (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY); без них env.pushEnabled = false и пуши не шлются.
// Мёртвые подписки (провайдер ответил 404/410 — пользователь отозвал разрешение или удалил приложение) удаляются.
// Отправитель подменяемый (setSender): тесты не ходят в сеть и могут имитировать ответы провайдеров.
const webpush = require("web-push");
const env = require("../config/env");
const prisma = require("./prisma");
const logger = require("./logger");

const TTL_S = 24 * 60 * 60; // сколько провайдер хранит пуш для выключенного устройства
const TIMEOUT_MS = 10_000;
const GONE = new Set([404, 410]);

async function webpushSender(sub, payload) {
  return webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
    vapidDetails: { subject: env.vapidSubject, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
    TTL: TTL_S,
    urgency: "normal",
    timeout: TIMEOUT_MS,
  });
}

let sender = webpushSender;
const setSender = (fn) => { sender = fn || webpushSender; };

const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Отправить одной подписке. Возвращает "sent" | "gone" (подписка удалена) | "failed" (временный сбой, подписка цела)
async function sendTo(sub, payload) {
  try {
    await sender(sub, payload);
    return "sent";
  } catch (err) {
    if (GONE.has(err.statusCode)) {
      await prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
      return "gone";
    }
    // тело ответа провайдера не пишем целиком: оно может содержать endpoint
    logger.error({ status: err.statusCode, err: err.message }, "не удалось отправить push");
    return "failed";
  }
}

// payload: { title, body, hash, tag } — hash открывается по клику (#/admin/submissions)
const serialize = (p) => JSON.stringify({ ...p, title: trim(String(p.title), 80), body: trim(String(p.body || ""), 200) });

// Всем действующим админам (роль и блокировка — из БД). Считает, сколько отправлено / удалено / не вышло.
async function notifyAdmins(payload) {
  const res = { sent: 0, gone: 0, failed: 0 };
  if (!env.pushEnabled) return res;
  const subs = await prisma.pushSubscription.findMany({ where: { user: { role: "ADMIN", isBlocked: false } } });
  const body = serialize(payload);
  const out = await Promise.all(subs.map((s) => sendTo(s, body)));
  for (const r of out) res[r]++;
  return res;
}

// «В фоне»: ответ API не ждёт push-сервисы, ошибка наружу не выходит (только в лог)
const pending = new Set();
function background(fn) {
  const p = Promise.resolve()
    .then(fn)
    .catch((err) => logger.error({ err: err.message }, "push: фоновая отправка не удалась"))
    .finally(() => pending.delete(p));
  pending.add(p);
  return p;
}
const idle = () => Promise.allSettled([...pending]);

module.exports = { notifyAdmins, sendTo, serialize, background, idle, setSender, webpushSender };
