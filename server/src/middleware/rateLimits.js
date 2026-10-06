// Ограничения частоты запросов (по IP; на Render реальный IP берётся из прокси — app.set("trust proxy")).
// Слои, от общего к частному:
//   global — любые запросы к /api/v1 (кроме /health): защита от наплыва;
//   write  — запросы, меняющие данные (POST/PUT/PATCH/DELETE), кроме sync;
//   sync   — POST /me/sync (дорогая операция: транзакция и пересчёт состояния);
//   loginPair — вход: строго по паре IP+e-mail (подбор пароля к одному аккаунту; считаются только неудачные попытки);
//   loginIp   — вход: мягкий общий по IP (общий Wi-Fi/CGNAT не должен упираться);
//   register  — регистрация по IP (от ботов — Turnstile и предохранитель, см. lib/turnstile);
//   /auth/refresh и /auth/me отдельных лимитов не имеют — только global (и не расходуют write).
//   upload — загрузка фото обычными пользователями (по id пользователя; админ без лимита);
//   view   — счётчик просмотров рецептов (POST /stats/view, публичный; не расходует общий лимит записи);
//   mail   — эндпоинты, отправляющие письма (повторное подтверждение, «забыли пароль»).
// Лимиты лежат в изменяемом объекте `limits`, чтобы тесты могли временно занизить их на настоящем app.
const { rateLimit, MemoryStore, ipKeyGenerator } = require("express-rate-limit");
const env = require("../config/env");

const MIN = 60 * 1000;
// в тестах лимиты не мешают остальным наборам; свои проверки лимитов занижают их сами
const loose = env.NODE_ENV === "test" ? 1_000_000 : null;

const limits = {
  global: { windowMs: 15 * MIN, limit: loose ?? 3000 },
  write: { windowMs: 15 * MIN, limit: loose ?? 150 },
  sync: { windowMs: 15 * MIN, limit: loose ?? 1500 },
  loginPair: { windowMs: 15 * MIN, limit: loose ?? 10 },
  loginIp: { windowMs: 15 * MIN, limit: loose ?? 200 },
  register: { windowMs: 15 * MIN, limit: loose ?? 50 },
  view: { windowMs: 15 * MIN, limit: loose ?? 600 },
  mail: { windowMs: 60 * MIN, limit: loose ?? 10 },
  upload: { windowMs: 60 * MIN, limit: loose ?? 20 },
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
// эти эндпоинты /auth считаются своими лимитами (или только общим), а не лимитом записи
const OWN_LIMIT = new Set(["/auth/login", "/auth/register", "/auth/refresh"]);

module.exports = {
  limits,
  global: make("global"),
  write: make("write", { skip: (req) => SAFE.has(req.method) || req.path.startsWith("/me/sync") || req.path === "/stats/view" || OWN_LIMIT.has(req.path) }),
  sync: make("sync"),
  // ставится после validate: e-mail уже приведён к нижнему регистру; успешные входы не считаются
  loginPair: make("loginPair", {
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${req.body?.email ?? ""}`,
    validate: { keyGeneratorIpFallback: false },
  }),
  loginIp: make("loginIp"),
  register: make("register"),
  view: make("view"),
  mail: make("mail"),
  // после requireUploader: ключ — пользователь, а не IP (за одним IP могут быть разные люди)
  upload: make("upload", { skip: (req) => req.isAdminUpload, keyGenerator: (req) => req.user.id, validate: { keyGeneratorIpFallback: false } }),
  // для тестов: обнулить счётчики всех лимитов
  resetAll: () => Object.values(stores).forEach((s) => s.resetAll()),
};
