// Резервная копия БД (формат pg_dump custom) в server/backups/. Работает и с локальной БД, и с Neon.
// Использование: npm run db:backup
// ВНИМАНИЕ: в дампе есть хэши паролей — папка backups/ в .gitignore, не публикуйте файлы.
const fs = require("fs");
const path = require("path");
const { dbUrl, describe, serverMajor, ensureDocker, runInContainer, exitCode } = require("./lib/pgtools");

const BACKUP_DIR = path.join(__dirname, "..", "backups");

async function main() {
  const url = dbUrl();
  ensureDocker();
  const major = await serverMajor();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
  const file = path.join(BACKUP_DIR, `recipes-${stamp}.dump`);
  console.log(`Копия ${describe(url)} (PostgreSQL ${major}) → ${path.relative(process.cwd(), file) || file}`);

  const out = fs.createWriteStream(file);
  await new Promise((r) => out.on("open", r));
  // только схема public: у Neon есть служебные схемы, которые не нужны и не восстанавливаются
  const child = runInContainer(major, 'pg_dump "$TARGET_URL" -n public -Fc --no-owner --no-privileges', {
    stdout: "pipe",
    url,
  });
  child.stdout.pipe(out);
  const code = await exitCode(child);
  await new Promise((r) => out.end(r));

  if (code !== 0 || fs.statSync(file).size === 0) {
    fs.rmSync(file, { force: true });
    console.error("Не удалось создать копию (pg_dump завершился с ошибкой).");
    process.exit(1);
  }
  console.log(`Готово: ${(fs.statSync(file).size / 1024).toFixed(1)} КБ`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
