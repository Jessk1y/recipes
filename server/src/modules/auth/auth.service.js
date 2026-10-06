const crypto = require("crypto");
const bcrypt = require("bcrypt");
const prisma = require("../../lib/prisma");
const { AppError } = require("../../lib/errors");
const env = require("../../config/env");
const emailAuth = require("./emailAuth.service");
const { signAccessToken, newRefreshToken, hashToken, REFRESH_TTL_MS } = require("../../lib/jwt");

const BCRYPT_COST = 12;
// выравнивает время ответа, когда пользователь не найден (защита от перебора e-mail)
const DUMMY_HASH = bcrypt.hashSync("dummy-password", BCRYPT_COST);

const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role,
  emailVerified: !!u.emailVerifiedAt || !env.mailEnabled,
});
const emailTaken = () => new AppError(409, "EMAIL_TAKEN", "Пользователь с таким e-mail уже существует");

async function issueRefreshToken(userId, familyId, db = prisma) {
  const token = newRefreshToken();
  await db.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return token;
}

async function startSession(user) {
  const refreshToken = await issueRefreshToken(user.id, crypto.randomUUID());
  return { user: publicUser(user), accessToken: signAccessToken(user), refreshToken };
}

async function register({ email, password, displayName }) {
  if (await prisma.user.findUnique({ where: { email } })) throw emailTaken();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  let user;
  try {
    // почта отключена → подтверждать нечем: сразу подтверждён (и останется таким, когда почта включится)
    user = await prisma.user.create({
      data: { email, passwordHash, displayName, emailVerifiedAt: env.mailEnabled ? null : new Date() },
    });
  } catch (e) {
    if (e.code === "P2002") throw emailTaken();
    throw e;
  }
  // письмо с подтверждением; если почта не сработала, регистрация всё равно удалась (письмо можно запросить повторно)
  const verificationSent = env.mailEnabled && (await emailAuth.sendVerificationAfterRegister(user));
  return { ...(await startSession(user)), verificationSent };
}

async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) throw new AppError(401, "INVALID_CREDENTIALS", "Неверный e-mail или пароль");
  if (user.isBlocked) throw new AppError(403, "ACCOUNT_BLOCKED", "Аккаунт заблокирован");
  return startSession(user);
}

const revokeFamily = (familyId, db = prisma) =>
  db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });

const tokenReused = () => new AppError(401, "TOKEN_REUSED", "Refresh-токен уже использован, войдите заново");

// Ротация: старый токен гасится, выдаётся новый в той же «семье».
// Повторное предъявление погашенного токена = кража → отзывается вся семья.
async function refresh({ refreshToken }) {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    include: { user: true },
  });
  if (!stored) throw new AppError(401, "INVALID_TOKEN", "Недействительный refresh-токен");

  if (stored.revokedAt) {
    await revokeFamily(stored.familyId);
    throw tokenReused();
  }
  if (stored.expiresAt < new Date()) throw new AppError(401, "TOKEN_EXPIRED", "Refresh-токен истёк");
  if (stored.user.isBlocked) {
    await revokeFamily(stored.familyId);
    throw new AppError(403, "ACCOUNT_BLOCKED", "Аккаунт заблокирован");
  }

  const next = await prisma.$transaction(async (tx) => {
    // атомарно: если параллельный запрос уже погасил токен, count будет 0
    const { count } = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) return null;
    return issueRefreshToken(stored.userId, stored.familyId, tx);
  });
  if (!next) {
    await revokeFamily(stored.familyId);
    throw tokenReused();
  }
  return { accessToken: signAccessToken(stored.user), refreshToken: next };
}

async function logout(userId, { refreshToken, all }) {
  if (all) {
    await prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return;
  }
  if (!refreshToken) throw new AppError(422, "VALIDATION_ERROR", "Нужен refreshToken или all: true");
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } });
  // чужой или несуществующий токен молча игнорируем — logout идемпотентен
  if (stored && stored.userId === userId) await revokeFamily(stored.familyId);
}

// Смена пароля из консоли (npm run set-password): новый хэш + отзыв всех refresh-токенов пользователя,
// чтобы старые сессии не пережили смену пароля. Блокировку и роль не трогает.
async function setPassword(email, password) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new AppError(404, "USER_NOT_FOUND", "Пользователь с таким e-mail не найден");
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const [, { count }] = await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  return { user: publicUser(user), revoked: count };
}

async function me(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.isBlocked) throw new AppError(401, "UNAUTHORIZED", "Пользователь не найден");
  return publicUser(user);
}

module.exports = { register, login, refresh, logout, me, setPassword };
