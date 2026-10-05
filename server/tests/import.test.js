// Импорт рецептов из JSON (recipes:import / seed) и обратный перевод для catalog:export.
process.env.NODE_ENV = "test";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/lib/prisma");
const { importRecipes, toJsonRecipe } = require("../src/lib/recipeIO");
const recipes = require("../src/modules/recipes/recipes.service");

const T = `zz${Date.now().toString(36)}`;
const CATEGORY = `Тест импорта ${T}`;
const json = (over = {}) => ({
  id: `import-${T}`,
  title: `Импортный пирог ${T}`,
  category: CATEGORY,
  tags: ["пирог", `тег-${T}`],
  main: ["Десерт"],
  image: "images/test.jpg",
  time: "1 ч 10 мин",
  servings: "6 порций",
  ingredients: [{ h: "Тесто" }, "Мука — 200 г", "Яйца"],
  steps: [{ h: "Выпечка" }, "Выпекать 25 мин."],
  ...over,
});

after(async () => {
  await prisma.recipe.deleteMany({ where: { slug: { startsWith: `import-${T}` } } });
  await prisma.tag.deleteMany({ where: { name: `тег-${T}` } });
  await prisma.category.deleteMany({ where: { name: CATEGORY } });
  await prisma.$disconnect();
});

test("импорт добавляет новые рецепты и не трогает существующие", async () => {
  const first = await importRecipes(prisma, [json()], { overwrite: false });
  assert.deepEqual(first.created, [`import-${T}`]);

  // правка «из админки», затем повторный импорт того же slug с другим содержимым
  await prisma.recipe.update({ where: { slug: `import-${T}` }, data: { title: "Правка админа" } });
  const second = await importRecipes(prisma, [json({ title: "Из файла" }), json({ id: `import-${T}-2` })], { overwrite: false });
  assert.deepEqual(second.skipped, [`import-${T}`]);
  assert.deepEqual(second.created, [`import-${T}-2`]);
  const kept = await prisma.recipe.findUnique({ where: { slug: `import-${T}` } });
  assert.equal(kept.title, "Правка админа");

  // seed (overwrite) перезаписывает
  const seed = await importRecipes(prisma, [json({ title: "Из файла" })], { overwrite: true });
  assert.deepEqual(seed.updated, [`import-${T}`]);
  assert.equal((await prisma.recipe.findUnique({ where: { slug: `import-${T}` } })).title, "Из файла");
});

test("рецепт с тегом вне словаря main отклоняется до записи", async () => {
  await assert.rejects(
    importRecipes(prisma, [json({ id: `import-${T}-bad`, main: ["Выпечка"] })], { overwrite: false }),
    /вне словаря main/
  );
  assert.equal(await prisma.recipe.count({ where: { slug: `import-${T}-bad` } }), 0);
});

test("toJsonRecipe возвращает рецепт в формате recipes.json", async () => {
  const full = await recipes.getBySlug(`import-${T}`, { role: "ADMIN" });
  const back = toJsonRecipe(full);
  assert.deepEqual(back.ingredients, [{ h: "Тесто" }, "Мука — 200 г", "Яйца"]);
  assert.deepEqual(back.steps, [{ h: "Выпечка" }, "Выпекать 25 мин."]);
  assert.deepEqual(back.main, ["Десерт"]);
  assert.equal(back.category, CATEGORY);
  assert.equal(back.id, `import-${T}`);
});
