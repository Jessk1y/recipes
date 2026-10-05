// Импорт data/recipes.json в БД. Идемпотентен: повторный запуск обновляет рецепты по slug.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const DATA_FILE = path.join(__dirname, "..", "..", "data", "recipes.json");

const MAIN_TAGS = require("../src/lib/mainTags");
const { durationSeconds, timeMinutes } = require("../src/lib/duration");
const { slugify } = require("../src/lib/slug");

// «Яйца — 4 шт» → { name: "Яйца", amount: "4 шт" }; без « — » количество пустое
function parseIngredient(item, position) {
  if (typeof item === "object") return { position, kind: "HEADER", name: item.h, amount: null };
  const i = item.indexOf(" — ");
  return i < 0
    ? { position, kind: "ITEM", name: item.trim(), amount: null }
    : { position, kind: "ITEM", name: item.slice(0, i).trim(), amount: item.slice(i + 3).trim() };
}

function parseStep(item, position) {
  if (typeof item === "object") return { position, kind: "HEADER", text: item.h, timerSeconds: null };
  return { position, kind: "ITEM", text: item, timerSeconds: durationSeconds(item) || null };
}

async function main() {
  const recipes = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const mainSet = new Set(MAIN_TAGS);
  const mainLower = new Set(MAIN_TAGS.map((t) => t.toLowerCase()));
  const baseTime = Date.now();

  // теги: основные из словаря + свободные (без дублей с основными и между собой)
  const tagNames = new Map(MAIN_TAGS.map((t) => [t.toLowerCase(), t]));
  for (const r of recipes) {
    for (const t of r.tags || []) if (!tagNames.has(t.toLowerCase())) tagNames.set(t.toLowerCase(), t);
  }
  const tagId = {};
  for (const name of tagNames.values()) {
    const tag = await prisma.tag.upsert({
      where: { name },
      update: { isMain: mainSet.has(name) },
      create: { name, isMain: mainSet.has(name) },
    });
    tagId[name.toLowerCase()] = tag.id;
  }

  const categoryId = {};
  for (const name of new Set(recipes.map((r) => r.category))) {
    const cat = await prisma.category.upsert({
      where: { slug: slugify(name) },
      update: { name },
      create: { name, slug: slugify(name) },
    });
    categoryId[name] = cat.id;
  }

  for (const [idx, r] of recipes.entries()) {
    const unknown = (r.main || []).filter((t) => !mainSet.has(t));
    if (unknown.length) throw new Error(`${r.id}: теги вне словаря main: ${unknown.join(", ")}`);

    const tagKeys = new Set([...(r.main || []), ...(r.tags || [])].map((t) => t.toLowerCase()));
    const minutes = timeMinutes(r.time);
    const data = {
      title: r.title,
      categoryId: categoryId[r.category],
      image: r.image || null,
      timeText: r.time || null,
      timeMinutes: minutes,
      servings: r.servings || null,
      status: "PUBLISHED",
      // порядок в JSON = порядок «новизны»: первый рецепт — самый свежий
      createdAt: new Date(baseTime - idx * 60_000),
    };

    await prisma.$transaction(async (tx) => {
      const recipe = await tx.recipe.upsert({
        where: { slug: r.id },
        update: data,
        create: { slug: r.id, ...data },
      });
      await tx.recipeTag.deleteMany({ where: { recipeId: recipe.id } });
      await tx.ingredient.deleteMany({ where: { recipeId: recipe.id } });
      await tx.step.deleteMany({ where: { recipeId: recipe.id } });
      await tx.recipeTag.createMany({
        data: [...tagKeys].map((k) => ({ recipeId: recipe.id, tagId: tagId[k] })),
      });
      await tx.ingredient.createMany({
        data: r.ingredients.map((it, i) => ({ recipeId: recipe.id, ...parseIngredient(it, i) })),
      });
      await tx.step.createMany({
        data: r.steps.map((it, i) => ({ recipeId: recipe.id, ...parseStep(it, i) })),
      });
    });
    console.log(`✓ ${r.id}`);
  }

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
