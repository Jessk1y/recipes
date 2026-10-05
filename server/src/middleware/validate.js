const { AppError } = require("../lib/errors");

function check(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const details = result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
  throw new AppError(422, "VALIDATION_ERROR", "Некорректные данные запроса", details);
}

// validate(schema) — проверяет req.body и подменяет его очищенными данными
module.exports = (schema) => (req, res, next) => {
  try {
    req.body = check(schema, req.body);
    next();
  } catch (e) {
    next(e);
  }
};

// validateQuery(schema) — то же для query-строки; в Express 5 req.query только для чтения,
// поэтому результат кладётся в req.validQuery
module.exports.query = (schema) => (req, res, next) => {
  try {
    req.validQuery = check(schema, req.query);
    next();
  } catch (e) {
    next(e);
  }
};
