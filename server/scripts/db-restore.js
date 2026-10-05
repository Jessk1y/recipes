// Восстановление БД из копии. ПЕРЕЗАПИСЫВАЕТ данные в БД из DATABASE_URL (таблицы пересоздаются).
// Использование: npm run db:restore -- [файл.dump] --yes
//   без файла берётся самая свежая копия из server/backups/; без --yes ничего не меняется (только показ цели).
const fs = require("fs");
const path = require("path");
const { dbUrl, describe, serverMajor, ensureDocker, runInContainer, exitCode } = require("./lib/pgtools");

const BACKUP_DIR = path.join(__dirname, "..", "backups");

function pickFile(arg) {
  if (arg) return path.resolve(arg);
  const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".dump")).sort() : [];
  if (!files.length) {
    console.error("В server/backups/ нет копий. Сначала: npm run db:backup");
    process.exit(1);
  }
  return path.join(BACKUP_DIR, files[files.length - 1]);
}

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const file = pickFile(args.find((a) => !a.startsWith("--")));
  if (!fs.existsSync(file)) {
    console.error(`Файл не найден: ${file}`);
    process.exit(1);
  }
  const url = dbUrl();
  console.log(`Восстановить ${file}\n         в БД ${describe(url)}`);
  if (!yes) {
    console.log("\nЭто ПЕРЕЗАПИШЕТ данные в указанной БД. Проверьте адрес выше и повторите с --yes:\n  npm run db:restore -- --yes");
    return;
  }

  ensureDocker();
  const major = await serverMajor();
  // --clean --if-exists: пересоздать объекты; single-transaction: при ошибке БД остаётся как была
  const child = runInContainer(
    major,
    'pg_restore -d "$TARGET_URL" --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error',
    { stdin: "pipe", url }
  );
  fs.createReadStream(file).on("error", () => child.kill()).pipe(child.stdin);
  const code = await exitCode(child);
  if (code !== 0) {
    console.error("Восстановление не удалось, БД не изменена (откат транзакции).");
    process.exit(1);
  }
  console.log("Готово.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
