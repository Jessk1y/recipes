// Cloudflare Turnstile: проверка токена капчи на сервере (POST siteverify). Токен одноразовый и живёт ~5 минут.
// Без ключей (env.turnstileEnabled = false: локально, тесты) проверка пропускается.
// Если Cloudflare не отвечает — отказ 503 (лучше попросить повторить, чем пустить ботов без проверки).
// Проверяющий подменяемый (setVerifier): тесты не ходят в сеть.
const env = require("../config/env");
const logger = require("./logger");
const { AppError } = require("./errors");

const URL_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 8000;

async function cloudflareVerifier(token, ip) {
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (ip) body.set("remoteip", ip);
  const res = await fetch(URL_VERIFY, { method: "POST", body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
  const data = await res.json();
  return { success: data.success === true, codes: data["error-codes"] || [] };
}

let verifier = cloudflareVerifier;
const setVerifier = (fn) => { verifier = fn || cloudflareVerifier; };

// Express-middleware: токен приходит в теле запроса (turnstileToken); из тела он не передаётся дальше (zod отбросит лишний ключ)
async function requireCaptcha(req, res, next) {
  try {
    if (!env.turnstileEnabled) return next();
    const token = req.body && req.body.turnstileToken;
    if (typeof token !== "string" || !token || token.length > 2048)
      throw new AppError(400, "CAPTCHA_REQUIRED", "Подтвердите, что вы не робот");
    let r;
    try {
      r = await verifier(token, req.ip);
    } catch (err) {
      logger.error({ err: err.message }, "Turnstile недоступен");
      throw new AppError(503, "CAPTCHA_UNAVAILABLE", "Не удалось проверить капчу, попробуйте ещё раз через минуту");
    }
    if (!r.success) {
      // internal-error — сбой на стороне Cloudflare, а не провал проверки
      if (r.codes && r.codes.includes("internal-error"))
        throw new AppError(503, "CAPTCHA_UNAVAILABLE", "Не удалось проверить капчу, попробуйте ещё раз через минуту");
      throw new AppError(400, "CAPTCHA_FAILED", "Проверка «я не робот» не пройдена — попробуйте ещё раз");
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireCaptcha, setVerifier };
