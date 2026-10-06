require("dotenv").config();
const { z } = require("zod");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL не задан"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET должен быть не короче 32 символов"),
  CORS_ORIGINS: z.string().default("http://localhost:8000"),
  CLOUDINARY_URL: z.string().optional(),
  STORAGE_DRIVER: z.enum(["local", "cloudinary"]).optional(),
  // адрес фронтенда — на него ведут ссылки из писем (подтверждение e-mail, сброс пароля)
  FRONTEND_URL: z.string().url().default("http://localhost:8000"),
  // почта: Brevo HTTP API. Без BREVO_API_KEY письма не уходят, а печатаются в лог (только вне production)
  BREVO_API_KEY: z.string().optional(),
  // Mailjet HTTP API (запасной вариант): ключ и секрет из Account Settings → REST API
  MAILJET_API_KEY: z.string().optional(),
  MAILJET_SECRET_KEY: z.string().optional(),
  MAIL_FROM_EMAIL: z.string().email().optional(),
  MAIL_FROM_NAME: z.string().default("Рецепты"),
  // сколько рецептов пользователь может отправить на модерацию за 24 часа
  SUBMISSIONS_PER_DAY: z.coerce.number().int().min(1).default(3),
  MAIL_DRIVER: z.enum(["brevo", "mailjet", "log", "memory", "off"]).optional(),
});

// пустые значения (VAR=) считаем незаданными — иначе пустой ключ из панели хостинга ломал бы запуск
const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
if (!parsed.success) {
  console.error("Ошибка конфигурации (.env):");
  for (const i of parsed.error.issues) console.error(` - ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}

const driver = parsed.data.STORAGE_DRIVER || (parsed.data.CLOUDINARY_URL ? "cloudinary" : "local");
if (driver === "cloudinary" && !/^cloudinary:\/\/[^:]+:[^@]+@.+/.test(parsed.data.CLOUDINARY_URL || "")) {
  console.error("Ошибка конфигурации: для Cloudinary нужен CLOUDINARY_URL вида cloudinary://<key>:<secret>@<cloud>");
  process.exit(1);
}
if (parsed.data.NODE_ENV === "production" && driver !== "cloudinary") {
  console.error("Ошибка конфигурации: в production фото хранятся в Cloudinary — задайте CLOUDINARY_URL");
  process.exit(1);
}

// Почта. В тестах письма никогда не уходят наружу (драйвер memory), даже если в .env лежит настоящий ключ.
// В production письма идут только через Brevo/Mailjet; без их ключей сервер всё равно стартует в режиме
// «почта отключена» (driver off, mailEnabled = false): новые пользователи считаются подтверждёнными,
// «забыли пароль» и повторная отправка отвечают 503 MAIL_DISABLED. Как только ключи появятся — режим включится сам.
// Вне production без ключей письма печатаются в лог (driver log).
const isProd = parsed.data.NODE_ENV === "production";
const keyed = parsed.data.MAILJET_API_KEY ? "mailjet" : parsed.data.BREVO_API_KEY ? "brevo" : null;
let mailDriver =
  parsed.data.NODE_ENV === "test" ? "memory" : parsed.data.MAIL_DRIVER || keyed || (isProd ? "off" : "log");
if (isProd && !["brevo", "mailjet"].includes(mailDriver)) mailDriver = "off";
if (mailDriver === "brevo" && !(parsed.data.BREVO_API_KEY && parsed.data.MAIL_FROM_EMAIL)) {
  console.error("Ошибка конфигурации: для отправки писем через Brevo нужны BREVO_API_KEY и MAIL_FROM_EMAIL");
  process.exit(1);
}
if (mailDriver === "mailjet" && !(parsed.data.MAILJET_API_KEY && parsed.data.MAILJET_SECRET_KEY && parsed.data.MAIL_FROM_EMAIL)) {
  console.error("Ошибка конфигурации: для Mailjet нужны MAILJET_API_KEY, MAILJET_SECRET_KEY и MAIL_FROM_EMAIL");
  process.exit(1);
}
if (isProd && mailDriver !== "off" && !process.env.FRONTEND_URL) {
  console.error("Ошибка конфигурации: когда включена почта, в production задайте FRONTEND_URL (адрес сайта для ссылок в письмах)");
  process.exit(1);
}

module.exports = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  mailDriver,
  // изменяемое поле: тесты временно переключают режим на настоящем app
  mailEnabled: mailDriver !== "off",
  frontendUrl: parsed.data.FRONTEND_URL.replace(/\/+$/, ""),
  isProd: parsed.data.NODE_ENV === "production",
};
