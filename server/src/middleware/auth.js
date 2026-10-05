const { AppError } = require("../lib/errors");
const { verifyAccessToken } = require("../lib/jwt");

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

module.exports = { requireAuth, optionalAuth, requireRole };
