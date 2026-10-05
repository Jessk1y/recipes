const { AppError } = require("../lib/errors");

// validate(schema) — проверяет req.body схемой Zod и подменяет его очищенными данными
module.exports = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
    return next(new AppError(422, "VALIDATION_ERROR", "Некорректные данные запроса", details));
  }
  req.body = result.data;
  next();
};
