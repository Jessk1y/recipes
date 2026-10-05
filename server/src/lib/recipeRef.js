const prisma = require("./prisma");

// Рецепты в пользовательских данных адресуются по slug (на фронтенде это recipe.id).
// Для избранного, заметок и списка покупок годятся только опубликованные рецепты.
const findPublished = (slug, db = prisma) =>
  db.recipe.findFirst({ where: { slug, status: "PUBLISHED" }, select: { id: true } });

// для удаления достаточно, чтобы рецепт существовал (в т.ч. черновик, снятый с публикации)
const findAny = (slug, db = prisma) => db.recipe.findUnique({ where: { slug }, select: { id: true } });

module.exports = { findPublished, findAny };
