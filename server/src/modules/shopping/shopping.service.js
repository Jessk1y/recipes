const prisma = require("../../lib/prisma");
const { AppError } = require("../../lib/errors");
const normName = require("../../lib/normName");
const { findPublished, findAny } = require("../../lib/recipeRef");

// Формат как в localStorage фронтенда: { name, contribs: [{ r: slug блюда | null, a: количество }] }
const include = {
  contribs: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { amount: true, recipe: { select: { slug: true } } },
  },
};

const toItem = (it) => ({
  id: it.id,
  name: it.name,
  checked: it.checked,
  contribs: it.contribs.map((c) => ({ r: c.recipe?.slug ?? null, a: c.amount ?? "" })),
});

// Все запросы ограничены userId из токена.
async function list(userId, db = prisma) {
  const items = await db.shoppingItem.findMany({
    where: { userId },
    include,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return items.map(toItem);
}

// Добавить вклад в позицию: позиции с одинаковым normName сливаются, одинаковый вклад
// (то же блюдо и то же количество) не дублируется. recipeId — id рецепта или null (вручную).
async function addEntry(userId, { name, amount, recipeId }, db = prisma) {
  const key = normName(name);
  // ON CONFLICT DO NOTHING: гонка двух запросов не рвёт транзакцию
  await db.shoppingItem.createMany({
    data: [{ userId, name: name.trim(), normName: key }],
    skipDuplicates: true,
  });
  const item = await db.shoppingItem.findUniqueOrThrow({
    where: { userId_normName: { userId, normName: key } },
    select: { id: true },
  });
  const amt = amount?.trim() || null;
  const exists = await db.shoppingContrib.findFirst({
    where: { itemId: item.id, recipeId: recipeId ?? null, amount: amt },
    select: { id: true },
  });
  if (exists) return false;
  await db.shoppingContrib.create({ data: { itemId: item.id, recipeId: recipeId ?? null, amount: amt } });
  return true;
}

// REST: все блюда должны существовать, иначе 404 и ничего не добавляется
async function addEntries(userId, entries) {
  return prisma.$transaction(async (tx) => {
    const ids = new Map();
    for (const slug of new Set(entries.map((e) => e.recipe).filter(Boolean))) {
      const recipe = await findPublished(slug, tx);
      if (!recipe) throw new AppError(404, "NOT_FOUND", `Рецепт не найден: ${slug}`);
      ids.set(slug, recipe.id);
    }
    let added = 0;
    for (const e of entries) {
      if (await addEntry(userId, { ...e, recipeId: e.recipe ? ids.get(e.recipe) : null }, tx)) added++;
    }
    return added;
  });
}

async function setChecked(userId, id, checked, db = prisma) {
  const { count } = await db.shoppingItem.updateMany({ where: { id, userId }, data: { checked } });
  return count > 0;
}

async function setCheckedByName(userId, name, checked, db = prisma) {
  const { count } = await db.shoppingItem.updateMany({
    where: { userId, normName: normName(name) },
    data: { checked },
  });
  return count > 0;
}

async function removeItem(userId, id, db = prisma) {
  const { count } = await db.shoppingItem.deleteMany({ where: { id, userId } });
  return count > 0;
}

async function removeItemByName(userId, name, db = prisma) {
  const { count } = await db.shoppingItem.deleteMany({ where: { userId, normName: normName(name) } });
  return count > 0;
}

// «Убрать блюдо»: удаляет вклады этого блюда, позиции без вкладов пропадают
async function removeDish(userId, slug, db = prisma) {
  const recipe = await findAny(slug, db);
  if (!recipe) return false;
  await db.shoppingContrib.deleteMany({ where: { recipeId: recipe.id, item: { userId } } });
  await db.shoppingItem.deleteMany({ where: { userId, contribs: { none: {} } } });
  return true;
}

async function clear(userId, db = prisma) {
  await db.shoppingItem.deleteMany({ where: { userId } });
}

module.exports = {
  list,
  addEntry,
  addEntries,
  setChecked,
  setCheckedByName,
  removeItem,
  removeItemByName,
  removeDish,
  clear,
};
