const env = require("./config/env");
const app = require("./app");
const logger = require("./lib/logger");
const prisma = require("./lib/prisma");
const cleanup = require("./lib/cleanup");

const server = app.listen(env.PORT, () =>
  logger.info(`API запущен: http://localhost:${env.PORT}/api/v1/health`)
);

if (!env.mailEnabled) {
  logger.warn("почта отключена: нет ключей Brevo/Mailjet — e-mail не подтверждается (все считаются подтверждёнными), «забыли пароль» недоступно (пароли сбрасывает админ: npm run set-password)");
}

cleanup.schedule();

function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
