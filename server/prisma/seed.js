// Импорт data/recipes.json в БД. Идемпотентен: повторный запуск ПЕРЕЗАПИСЫВАЕТ рецепты по slug
// (правки из админки будут потеряны). Чтобы только добавить новые — npm run recipes:import.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { importRecipes } = require("../src/lib/recipeIO");

const prisma = new PrismaClient();
const DATA_FILE = path.join(__dirname, "..", "..", "data", "recipes.json");

async function main() {
  const recipes = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  await importRecipes(prisma, recipes, { overwrite: true, log: console.log });

  const [n, ing, st, tg] = await Promise.all([
    prisma.recipe.count(), prisma.ingredient.count(), prisma.step.count(), prisma.tag.count(),
  ]);
  console.log(`Готово: рецептов ${n}, ингредиентов ${ing}, шагов ${st}, тегов ${tg}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
