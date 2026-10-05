const pino = require("pino");
const env = require("../config/env");

module.exports = pino({
  level: env.NODE_ENV === "test" ? "silent" : "info",
  // пароли и токены никогда не попадают в журнал
  redact: ["req.headers.authorization", "req.body.password", "req.body.refreshToken"],
  transport: env.isProd ? undefined : { target: "pino-pretty", options: { colorize: true } },
});
