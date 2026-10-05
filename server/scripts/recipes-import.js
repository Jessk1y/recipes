// Добавление НОВЫХ рецептов из JSON (формат data/recipes.json) в БД из DATABASE_URL.
// Рецепты, чей slug (поле id) уже есть в БД, пропускаются — правки из админки не затираются.
// Использование: npm run recipes:import -- [файл.json] [--yes]
//   по умолчанию файл ../data/recipes.json; без --yes только показывает, что будет добавлено.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { importRecipes } = require("../src/lib/recipeIO");
const { dbUrl, describe } = require("./lib/pgtools");

const DEFAULT_FILE = path.join(__dirname, "..", "..", "data", "recipes.json");

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const file = path.resolve(args.find((a) => !a.startsWith("--")) || DEFAULT_FILE);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const recipes = Array.isArray(raw) ? raw : [raw];
  console.log(`Файл ${file} (рецептов: ${recipes.length})\nБД   ${describe(dbUrl())}`);

  const prisma = new PrismaClient();
  try {
    const existing = new Set(
      (await prisma.recipe.findMany({ where: { slug: { in: recipes.map((r) => r.id) } }, select: { slug: true } }))
        .map((r) => r.slug)
    );
    const fresh = recipes.filter((r) => !existing.has(r.id));
    console.log(`Уже в БД (пропуск): ${recipes.length - fresh.length}. Новых: ${fresh.length}`);
    fresh.forEach((r) => console.log(`  + ${r.id} — ${r.title}`));
    if (!fresh.length) return;
    if (!yes) {
      console.log("\nПроверьте адрес БД и список выше и повторите с --yes:\n  npm run recipes:import -- --yes");
      return;
    }
    const res = await importRecipes(prisma, recipes, { overwrite: false, log: console.log });
    console.log(`Готово: добавлено ${res.created.length}, пропущено ${res.skipped.length}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
