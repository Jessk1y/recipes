// Почтовые сценарии auth: подтверждение e-mail и сброс пароля.
// Токен — 32 случайных байта; в письме он целиком, в БД лежит только SHA-256 (как у refresh-токенов).
// Токен одноразовый: погашается условным UPDATE (usedAt IS NULL), поэтому из двух параллельных
// запросов с одной ссылкой сработает ровно один.
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const prisma = require("../../lib/prisma");
const logger = require("../../lib/logger");
const { AppError } = require("../../lib/errors");
const { hashToken } = require("../../lib/jwt");
const mailer = require("../../lib/mailer");
const templates = require("../../lib/mailTemplates");

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000; // не чаще одного письма в минуту на пользователя и тип
const MAX_PER_HOUR = 5; // и не больше 5 в час
const BCRYPT_COST = 12;

const invalidLink = () => new AppError(400, "INVALID_TOKEN", "Ссылка недействительна, устарела или уже использована");

// Сколько писем этого типа пользователь запросил за последний час и когда было последнее
async function recentCount(userId, type) {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await prisma.emailToken.findMany({
    where: { userId, type, createdAt: { gte: since } },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return { count: rows.length, last: rows[0]?.createdAt };
}

async function issueToken(userId, type, ttlMs, db = prisma) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.emailToken.create({
    data: { userId, type, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) },
  });
  return token;
}

// Письмо с подтверждением; при превышении лимитов бросает 429
async function sendVerification(user) {
  const { count, last } = await recentCount(user.id, "VERIFY");
  if (last && Date.now() - last.getTime() < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (Date.now() - last.getTime())) / 1000);
    throw new AppError(429, "RESEND_TOO_SOON", `Письмо уже отправлено. Повторить можно через ${wait} с`, { retryAfterSec: wait });
  }
  if (count >= MAX_PER_HOUR) {
    throw new AppError(429, "RESEND_LIMIT", "Слишком много писем за час, попробуйте позже", { retryAfterSec: 3600 });
  }
  const token = await issueToken(user.id, "VERIFY", VERIFY_TTL_MS);
  await mailer.send({ to: user.email, ...templates.verifyEmail(user, token) });
}

// После регистрации: сбой почты не должен ронять регистрацию — пользователь запросит письмо повторно
async function sendVerificationAfterRegister(user) {
  try {
    await sendVerification(user);
    return true;
  } catch (err) {
    logger.error({ err: err.message }, "письмо подтверждения после регистрации не отправлено");
    return false;
  }
}

async function resendVerification(userId) {
  mailer.assertEnabled(); // почта отключена → 503 MAIL_DISABLED
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(401, "UNAUTHORIZED", "Пользователь не найден");
  if (user.isBlocked) throw new AppError(403, "ACCOUNT_BLOCKED", "Аккаунт заблокирован");
  if (user.emailVerifiedAt) throw new AppError(409, "ALREADY_VERIFIED", "E-mail уже подтверждён");
  try {
    await sendVerification(user);
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ err: err.message }, "не удалось отправить письмо подтверждения");
    throw new AppError(502, "EMAIL_SEND_FAILED", "Не удалось отправить письмо, попробуйте позже");
  }
}

async function verifyEmail({ token }) {
  const row = await prisma.emailToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.type !== "VERIFY" || row.usedAt || row.expiresAt < new Date()) throw invalidLink();
  const user = await prisma.$transaction(async (tx) => {
    const { count } = await tx.emailToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (count === 0) throw invalidLink();
    const u = await tx.user.findUnique({ where: { id: row.userId } });
    if (u.emailVerifiedAt) return u;
    return tx.user.update({ where: { id: u.id }, data: { emailVerifiedAt: new Date() } });
  });
  return { verified: true, email: user.email };
}

// Вызывающий всегда отвечает одинаково — не раскрываем, зарегистрирован ли e-mail.
// Письмо уходит в фоне (время ответа не зависит от того, есть ли такой пользователь).
async function forgotPassword({ email }) {
  mailer.assertEnabled(); // одинаковый ответ для всех e-mail, поэтому не раскрывает, кто зарегистрирован
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.isBlocked) return;
  const { count, last } = await recentCount(user.id, "RESET");
  if (count >= MAX_PER_HOUR || (last && Date.now() - last.getTime() < COOLDOWN_MS)) return;
  const token = await prisma.$transaction(async (tx) => {
    // действует только последняя ссылка
    await tx.emailToken.updateMany({ where: { userId: user.id, type: "RESET", usedAt: null }, data: { usedAt: new Date() } });
    return issueToken(user.id, "RESET", RESET_TTL_MS, tx);
  });
  mailer.sendInBackground({ to: user.email, ...templates.resetPassword(user, token) });
}

// Новый пароль по ссылке: токен гасится, пароль меняется, ВСЕ сессии пользователя отзываются.
// Переход по ссылке из письма доказывает владение ящиком, поэтому e-mail заодно считается подтверждённым.
async function resetPassword({ token, password }) {
  const row = await prisma.emailToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.type !== "RESET" || row.usedAt || row.expiresAt < new Date()) throw invalidLink();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.emailToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (count === 0) throw invalidLink();
    const now = new Date();
    const u = await tx.user.findUnique({ where: { id: row.userId }, select: { emailVerifiedAt: true } });
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash, emailVerifiedAt: u.emailVerifiedAt ?? now } });
    await tx.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: now } });
    await tx.emailToken.updateMany({ where: { userId: row.userId, type: "RESET", usedAt: null }, data: { usedAt: now } });
  });
}

module.exports = {
  sendVerificationAfterRegister, resendVerification, verifyEmail, forgotPassword, resetPassword,
};
