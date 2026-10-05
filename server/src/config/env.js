require("dotenv").config();
const { z } = require("zod");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL не задан"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET должен быть не короче 32 символов"),
  CORS_ORIGINS: z.string().default("http://localhost:8000"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Ошибка конфигурации (.env):");
  for (const i of parsed.error.issues) console.error(` - ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}

module.exports = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  isProd: parsed.data.NODE_ENV === "production",
};
