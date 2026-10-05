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

module.exports = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  isProd: parsed.data.NODE_ENV === "production",
};
