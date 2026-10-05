// Общее для db:backup / db:restore. pg_dump и pg_restore запускаются в одноразовом Docker-контейнере
// postgres:<мажорная версия сервера>-alpine, поэтому ставить клиент PostgreSQL на Windows не нужно,
// а версия утилит всегда совпадает с версией БД (локальной в Docker или Neon — по DATABASE_URL).
require("dotenv").config();
const { spawn, spawnSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");

const dbUrl = () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL не задан (server/.env или переменная окружения)");
    process.exit(1);
  }
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.delete("schema"); // параметр Prisma, libpq его не знает
  return u;
};

// описание цели без пароля — для вывода пользователю
const describe = (u) => `${u.hostname}${u.port ? ":" + u.port : ""}/${u.pathname.slice(1)}`;

// из контейнера localhost — это сам контейнер; хост-машина доступна как host.docker.internal
const forContainer = (u) => {
  const c = new URL(u.href);
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(c.hostname)) c.hostname = "host.docker.internal";
  return c.href;
};

async function serverMajor() {
  const prisma = new PrismaClient();
  try {
    const [{ v }] = await prisma.$queryRaw`SELECT current_setting('server_version_num')::int AS v`;
    return Math.floor(v / 10000);
  } finally {
    await prisma.$disconnect();
  }
}

function ensureDocker() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    console.error("Docker недоступен. Запустите Docker Desktop и повторите.");
    process.exit(1);
  }
}

// запускает shell-команду в контейнере с утилитами PostgreSQL; URL передаётся через окружение, не в аргументах
function runInContainer(major, script, { stdin = "ignore", stdout = "inherit", url }) {
  return spawn(
    "docker",
    ["run", "--rm", ...(stdin === "pipe" ? ["-i"] : []), "-e", "TARGET_URL", `postgres:${major}-alpine`, "sh", "-c", script],
    { stdio: [stdin, stdout, "inherit"], env: { ...process.env, TARGET_URL: forContainer(url) } }
  );
}

const exitCode = (child) => new Promise((resolve) => child.on("close", resolve).on("error", () => resolve(1)));

module.exports = { dbUrl, describe, serverMajor, ensureDocker, runInContainer, exitCode };
