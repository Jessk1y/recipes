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
  MAIL_DRIVER: z.enum(["brevo", "mailjet", "log", "memory"]).optional(),
});

const parsed = schema.safeParse(process.env);
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

// в тестах письма никогда не уходят наружу, даже если в .env лежит настоящий ключ Brevo
const mailDriver =
  parsed.data.NODE_ENV === "test" ? "memory" : parsed.data.MAIL_DRIVER ||
      (parsed.data.MAILJET_API_KEY ? "mailjet" : parsed.data.BREVO_API_KEY ? "brevo" : "log");
if (mailDriver === "brevo" && !(parsed.data.BREVO_API_KEY && parsed.data.MAIL_FROM_EMAIL)) {
  console.error("Ошибка конфигурации: для отправки писем через Brevo нужны BREVO_API_KEY и MAIL_FROM_EMAIL");
  process.exit(1);
}
if (mailDriver === "mailjet" && !(parsed.data.MAILJET_API_KEY && parsed.data.MAILJET_SECRET_KEY && parsed.data.MAIL_FROM_EMAIL)) {
  console.error("Ошибка конфигурации: для Mailjet нужны MAILJET_API_KEY, MAILJET_SECRET_KEY и MAIL_FROM_EMAIL");
  process.exit(1);
}
if (parsed.data.NODE_ENV === "production" && !['brevo', 'mailjet'].includes(mailDriver)) {
  console.error("Ошибка конфигурации: в production письма уходят через Brevo или Mailjet — задайте ключи и MAIL_FROM_EMAIL");
  process.exit(1);
}

if (parsed.data.NODE_ENV === "production" && !process.env.FRONTEND_URL) {
  console.error("Ошибка конфигурации: в production задайте FRONTEND_URL (адрес сайта для ссылок в письмах)");
  process.exit(1);
}

module.exports = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  mailDriver,
  frontendUrl: parsed.data.FRONTEND_URL.replace(/\/+$/, ""),
  isProd: parsed.data.NODE_ENV === "production",
};
