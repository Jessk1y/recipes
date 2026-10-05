// Перевод рецептов между форматом data/recipes.json (фронтенд) и БД.
// Используется в seed (перезапись по slug), recipes:import (только новые) и catalog:export.
const MAIN_TAGS = require("./mainTags");
const { durationSeconds, timeMinutes } = require("./duration");
const { slugify } = require("./slug");

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

// Проверка рецепта из JSON до записи в БД — ошибка с понятным текстом вместо падения Prisma
function check(r) {
  const errors = [];
  if (!r.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id)) errors.push("id — латиница, цифры и дефисы");
  if (!r.title) errors.push("нет title");
  if (!r.category) errors.push("нет category");
  if (!Array.isArray(r.ingredients) || !r.ingredients.length) errors.push("нет ingredients");
  if (!Array.isArray(r.steps) || !r.steps.length) errors.push("нет steps");
  const unknown = (r.main || []).filter((t) => !MAIN_TAGS.includes(t));
  if (unknown.length) errors.push(`теги вне словаря main: ${unknown.join(", ")}`);
  if (!(r.main || []).length) errors.push("пустое поле main");
  if (errors.length) throw new Error(`${r.id || r.title || "?"}: ${errors.join("; ")}`);
}

// recipes — массив в формате recipes.json (первый = самый свежий).
// overwrite=true: существующие по slug обновляются (seed); false: пропускаются (recipes:import),
// чтобы не затереть правки, сделанные в админке.
// Возвращает { created: [slug], updated: [slug], skipped: [slug] }.
async function importRecipes(prisma, recipes, { overwrite, log = () => {} }) {
  recipes.forEach(check);
  const result = { created: [], updated: [], skipped: [] };
  const existing = new Set(
    (await prisma.recipe.findMany({ where: { slug: { in: recipes.map((r) => r.id) } }, select: { slug: true } }))
      .map((r) => r.slug)
  );
  const todo = overwrite ? recipes : recipes.filter((r) => !existing.has(r.id));
  for (const r of recipes) if (!overwrite && existing.has(r.id)) result.skipped.push(r.id);
  if (!todo.length) return result;

  const mainSet = new Set(MAIN_TAGS);
  // теги: основные из словаря + свободные (без дублей с основными и между собой)
  const tagNames = new Map(MAIN_TAGS.map((t) => [t.toLowerCase(), t]));
  for (const r of todo) {
    for (const t of r.tags || []) if (!tagNames.has(t.toLowerCase())) tagNames.set(t.toLowerCase(), t);
  }
  const tagId = {};
  for (const t of await prisma.tag.findMany()) tagId[t.name.toLowerCase()] = t.id;
  for (const name of tagNames.values()) {
    if (tagId[name.toLowerCase()] && !mainSet.has(name)) continue; // свободный тег уже есть
    const tag = await prisma.tag.upsert({
      where: { name },
      update: { isMain: mainSet.has(name) },
      create: { name, isMain: mainSet.has(name) },
    });
    tagId[name.toLowerCase()] = tag.id;
  }

  const categoryId = {};
  for (const name of new Set(todo.map((r) => r.category))) {
    const cat = await prisma.category.upsert({
      where: { slug: slugify(name) },
      update: overwrite ? { name } : {},
      create: { name, slug: slugify(name) },
    });
    categoryId[name] = cat.id;
  }

  // порядок в JSON = порядок «новизны»: первый рецепт — самый свежий.
  // seed раскладывает весь файл от «сейчас» назад; импорт ставит новые рецепты выше всех существующих.
  const baseTime = Date.now();
  for (const [idx, r] of todo.entries()) {
    const tagKeys = new Set([...(r.main || []), ...(r.tags || [])].map((t) => t.toLowerCase()));
    const data = {
      title: r.title,
      categoryId: categoryId[r.category],
      image: r.image || null,
      timeText: r.time || null,
      timeMinutes: timeMinutes(r.time),
      servings: r.servings || null,
      status: "PUBLISHED",
      createdAt: new Date(baseTime - idx * (overwrite ? 60_000 : 1_000)),
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
    (existing.has(r.id) ? result.updated : result.created).push(r.id);
    log(`✓ ${r.id}`);
  }
  return result;
}

// Рецепт из API (toFull) → формат recipes.json. Та же логика, что fromApi() в js/data/adapter.js.
function toJsonRecipe(r) {
  return {
    id: r.slug,
    title: r.title,
    category: r.category.name,
    tags: r.tags,
    main: r.main,
    image: r.image || "",
    time: r.time || "",
    servings: r.servings || "",
    ingredients: r.ingredients.map((i) =>
      i.kind === "HEADER" ? { h: i.name } : i.amount ? `${i.name} — ${i.amount}` : i.name
    ),
    steps: r.steps.map((s) => (s.kind === "HEADER" ? { h: s.text } : s.text)),
  };
}

module.exports = { parseIngredient, parseStep, importRecipes, toJsonRecipe };
