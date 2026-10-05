const { AppError } = require("../lib/errors");
const { verifyAccessToken } = require("../lib/jwt");

// Auth Guard: проверяет access JWT и кладёт { id, role } в req.user
function requireAuth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return next(new AppError(401, "UNAUTHORIZED", "Требуется авторизация"));
  try {
    const payload = verifyAccessToken(m[1]);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(new AppError(401, "TOKEN_EXPIRED", "Токен недействителен или истёк"));
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role)
    ? next()
    : next(new AppError(403, "FORBIDDEN", "Недостаточно прав"));

module.exports = { requireAuth, requireRole };
