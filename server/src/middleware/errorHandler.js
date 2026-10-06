const { AppError } = require("../lib/errors");
const logger = require("../lib/logger");
const env = require("../config/env");

function notFound(req, res, next) {
  next(new AppError(404, "NOT_FOUND", "Маршрут не найден"));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // некорректный JSON в теле запроса
  if (err.type === "entity.parse.failed") {
    err = new AppError(400, "BAD_JSON", "Некорректный JSON");
  }
  if (err.type === "entity.too.large") {
    err = new AppError(413, "PAYLOAD_TOO_LARGE", "Слишком большое тело запроса");
  }
  if (err instanceof AppError) {
    if (err.headers) res.set(err.headers);
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
  }
  (req.log || logger).error({ err }, "unhandled error");
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: env.isProd ? "Внутренняя ошибка сервера" : err.message,
      details: null,
    },
  });
}

module.exports = { notFound, errorHandler };
