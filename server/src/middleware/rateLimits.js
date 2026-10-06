// Ограничения частоты запросов (по IP; на Render реальный IP берётся из прокси — app.set("trust proxy")).
// Слои, от общего к частному:
//   global — любые запросы к /api/v1 (кроме /health): защита от наплыва;
//   write  — запросы, меняющие данные (POST/PUT/PATCH/DELETE), кроме sync;
//   sync   — POST /me/sync (дорогая операция: транзакция и пересчёт состояния);
//   auth   — весь /auth (перебор паролей);
//   mail   — эндпоинты, отправляющие письма (повторное подтверждение, «забыли пароль»).
// Лимиты лежат в изменяемом объекте `limits`, чтобы тесты могли временно занизить их на настоящем app.
const { rateLimit, MemoryStore } = require("express-rate-limit");
const env = require("../config/env");

const MIN = 60 * 1000;
// в тестах лимиты не мешают остальным наборам; свои проверки лимитов занижают их сами
const loose = env.NODE_ENV === "test" ? 1_000_000 : null;

const limits = {
  global: { windowMs: 15 * MIN, limit: loose ?? 600 },
  write: { windowMs: 15 * MIN, limit: loose ?? 150 },
  sync: { windowMs: 15 * MIN, limit: loose ?? 300 },
  auth: { windowMs: 15 * MIN, limit: loose ?? 30 },
  mail: { windowMs: 60 * MIN, limit: loose ?? 10 },
};

const stores = {};
const message = { error: { code: "RATE_LIMITED", message: "Слишком много запросов, попробуйте позже", details: null } };

function make(name, extra = {}) {
  stores[name] = new MemoryStore();
  return rateLimit({
    windowMs: limits[name].windowMs,
    limit: () => limits[name].limit,
    store: stores[name],
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message,
    ...extra,
  });
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

module.exports = {
  limits,
  global: make("global"),
  write: make("write", { skip: (req) => SAFE.has(req.method) || req.path.startsWith("/me/sync") }),
  sync: make("sync"),
  auth: make("auth"),
  mail: make("mail"),
  // для тестов: обнулить счётчики всех лимитов
  resetAll: () => Object.values(stores).forEach((s) => s.resetAll()),
};
