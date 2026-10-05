const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const pinoHttp = require("pino-http");
const env = require("./config/env");
const logger = require("./lib/logger");
const prisma = require("./lib/prisma");
const storage = require("./lib/storage");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const app = express();
if (env.isProd) app.set("trust proxy", 1); // за прокси Render — реальный IP клиента для rate-limit

app.use(helmet());
app.use(cors({ origin: env.corsOrigins }));
app.use(express.json({ limit: "100kb" }));
app.use(pinoHttp({ logger, genReqId: () => crypto.randomUUID() }));

app.get("/api/v1/health", async (req, res) => {
  let db = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = "error";
  }
  res.status(db === "ok" ? 200 : 503).json({ status: db === "ok" ? "ok" : "degraded", db });
});

// загруженные фото; фронтенд на другом домене, поэтому разрешаем кросс-доменную загрузку картинок
app.use(
  "/uploads",
  (req, res, next) => {
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  },
  express.static(storage.UPLOAD_DIR, { index: false })
);

app.use("/api/v1/auth", require("./modules/auth/auth.router"));
app.use("/api/v1/recipes", require("./modules/recipes/recipes.router"));
app.get("/api/v1/catalog/snapshot", require("./modules/recipes/recipes.controller").snapshot);
app.use("/api/v1", require("./modules/taxonomy/taxonomy.router"));
app.use("/api/v1/uploads", require("./modules/media/media.router"));
// личные данные (только для вошедшего): более конкретные пути подключаются раньше /me
app.use("/api/v1/me/shopping", require("./modules/shopping/shopping.router"));
app.use("/api/v1/me/sync", require("./modules/sync/sync.router"));
app.use("/api/v1/me", require("./modules/me/me.router"));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
