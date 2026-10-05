const env = require("./config/env");
const app = require("./app");
const logger = require("./lib/logger");
const prisma = require("./lib/prisma");

const server = app.listen(env.PORT, () =>
  logger.info(`API запущен: http://localhost:${env.PORT}/api/v1/health`)
);

function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
