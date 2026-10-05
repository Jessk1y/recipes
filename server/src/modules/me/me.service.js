const prisma = require("../../lib/prisma");
const { AppError } = require("../../lib/errors");
const { findPublished, findAny } = require("../../lib/recipeRef");

const recipeNotFound = () => new AppError(404, "NOT_FOUND", "Рецепт не найден");
const published = { recipe: { status: "PUBLISHED" } };

// Каждый запрос ограничен userId из токена — чужие данные недостижимы по построению.

async function listFavorites(userId, db = prisma) {
  const rows = await db.favorite.findMany({
    where: { userId, ...published },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, recipe: { select: { slug: true } } },
  });
  return rows.map((f) => ({ slug: f.recipe.slug, createdAt: f.createdAt }));
}

// идемпотентно; false — рецепта нет или он не опубликован
async function addFavorite(userId, slug, db = prisma) {
  const recipe = await findPublished(slug, db);
  if (!recipe) return false;
  await db.favorite.createMany({ data: [{ userId, recipeId: recipe.id }], skipDuplicates: true });
  return true;
}

async function removeFavorite(userId, slug, db = prisma) {
  const recipe = await findAny(slug, db);
  if (recipe) await db.favorite.deleteMany({ where: { userId, recipeId: recipe.id } });
  return Boolean(recipe);
}

async function listNotes(userId, db = prisma) {
  const rows = await db.note.findMany({
    where: { userId, ...published },
    orderBy: { updatedAt: "desc" },
    select: { text: true, updatedAt: true, recipe: { select: { slug: true } } },
  });
  return rows.map((n) => ({ slug: n.recipe.slug, text: n.text, updatedAt: n.updatedAt }));
}

// Записать заметку. Пустой текст = удалить (как на фронтенде). at — время правки по часам клиента.
// lww=true (синхронизация): устаревшая правка не затирает более новую → "STALE".
async function setNote(userId, slug, text, { at = new Date(), lww = false } = {}, db = prisma) {
  const recipe = await findPublished(slug, db);
  if (!recipe) return "NOT_FOUND";
  const key = { userId_recipeId: { userId, recipeId: recipe.id } };
  const current = await db.note.findUnique({ where: key });
  if (lww && current && current.updatedAt >= at) return "STALE";
  if (!text.trim()) {
    if (current) await db.note.delete({ where: key });
    return "REMOVED";
  }
  await db.note.upsert({
    where: key,
    create: { userId, recipeId: recipe.id, text, updatedAt: at },
    update: { text, updatedAt: at },
  });
  return "SAVED";
}

async function removeNote(userId, slug, { at = new Date(), lww = false } = {}, db = prisma) {
  const recipe = await findAny(slug, db);
  if (!recipe) return "NOT_FOUND";
  const key = { userId_recipeId: { userId, recipeId: recipe.id } };
  if (lww) {
    const current = await db.note.findUnique({ where: key });
    if (current && current.updatedAt > at) return "STALE";
  }
  await db.note.deleteMany({ where: { userId, recipeId: recipe.id } });
  return "REMOVED";
}

const mustExist = (ok) => {
  if (!ok) throw recipeNotFound();
};

module.exports = {
  listFavorites,
  addFavorite,
  removeFavorite,
  listNotes,
  setNote,
  removeNote,
  recipeNotFound,
  mustExist,
};
