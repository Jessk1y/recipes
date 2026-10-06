const { AppError } = require("../lib/errors");
const { verifyAccessToken } = require("../lib/jwt");
const prisma = require("../lib/prisma");
const env = require("../config/env");

function readToken(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  return m ? m[1] : null;
}

// Auth Guard: проверяет access JWT и кладёт { id, role } в req.user
function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return next(new AppError(401, "UNAUTHORIZED", "Требуется авторизация"));
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(new AppError(401, "TOKEN_EXPIRED", "Токен недействителен или истёк"));
  }
}

// Публичные маршруты, у которых для админа больше возможностей: невалидный токен = гость
function optionalAuth(req, res, next) {
  const token = readToken(req);
  if (token) {
    try {
      const payload = verifyAccessToken(token);
      req.user = { id: payload.sub, role: payload.role };
    } catch {
      /* гость */
    }
  }
  next();
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role)
    ? next()
    : next(new AppError(403, "FORBIDDEN", "Недостаточно прав"));

// Для админки роль и блокировку берём из БД, а не из JWT: снятие прав и блокировка
// действуют сразу, а не через 15 минут (срок жизни access-токена).
async function requireActiveAdmin(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true, isBlocked: true } });
    if (!user) return next(new AppError(401, "UNAUTHORIZED", "Пользователь не найден"));
    if (user.isBlocked) return next(new AppError(403, "ACCOUNT_BLOCKED", "Аккаунт заблокирован"));
    if (user.role !== "ADMIN") return next(new AppError(403, "FORBIDDEN", "Недостаточно прав"));
    req.user.role = user.role;
    next();
  } catch (e) {
    next(e);
  }
}

// Для действий, доступных только пользователям с подтверждённым e-mail (например, предложить рецепт).
// Ставится после requireAuth; статус читается из БД, а не из JWT — подтверждение действует сразу.
// Пока такой маршрут не появился, guard покрыт тестами (tests/email.test.js).
async function requireVerifiedEmail(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { emailVerifiedAt: true, isBlocked: true } });
    if (!user) return next(new AppError(401, "UNAUTHORIZED", "Пользователь не найден"));
    if (user.isBlocked) return next(new AppError(403, "ACCOUNT_BLOCKED", "Аккаунт заблокирован"));
    // при отключённой почте подтверждать нечем — требование снято (блокировка по-прежнему действует)
    if (env.mailEnabled && !user.emailVerifiedAt) return next(new AppError(403, "EMAIL_NOT_VERIFIED", "Подтвердите e-mail, чтобы выполнить это действие"));
    next();
  } catch (e) {
    next(e);
  }
}

// Загрузка фото: действующий админ или пользователь с подтверждённым e-mail (для предложений рецептов).
// Роль и подтверждение читаются из БД; req.isAdminUpload — чтобы лимит загрузок не действовал на админа.
async function requireUploader(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true, isBlocked: true, emailVerifiedAt: true } });
    if (!user) return next(new AppError(401, "UNAUTHORIZED", "Пользователь не найден"));
    if (user.isBlocked) return next(new AppError(403, "ACCOUNT_BLOCKED", "Аккаунт заблокирован"));
    req.isAdminUpload = user.role === "ADMIN";
    if (env.mailEnabled && !req.isAdminUpload && !user.emailVerifiedAt) {
      return next(new AppError(403, "EMAIL_NOT_VERIFIED", "Подтвердите e-mail, чтобы загружать фото"));
    }
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { requireAuth, optionalAuth, requireRole, requireActiveAdmin, requireVerifiedEmail, requireUploader };
