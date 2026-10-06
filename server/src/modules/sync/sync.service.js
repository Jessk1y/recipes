const prisma = require("../../lib/prisma");
const me = require("../me/me.service");
const shopping = require("../shopping/shopping.service");
const { findPublished } = require("../../lib/recipeRef");
const { touchActive } = require("../../lib/activity");

// Применяет одну операцию. Возвращает null (применена) или код причины пропуска.
async function applyOp(userId, op, tx) {
  switch (op.type) {
    case "favorite.add":
      return (await me.addFavorite(userId, op.slug, tx)) ? null : "NOT_FOUND";
    case "favorite.remove":
      return (await me.removeFavorite(userId, op.slug, tx)) ? null : "NOT_FOUND";
    case "note.set": {
      const r = await me.setNote(userId, op.slug, op.text, { at: op.at, lww: true }, tx);
      return r === "NOT_FOUND" || r === "STALE" ? r : null;
    }
    case "note.remove": {
      const r = await me.removeNote(userId, op.slug, { at: op.at, lww: true }, tx);
      return r === "NOT_FOUND" || r === "STALE" ? r : null;
    }
    case "shopping.add": {
      let recipeId = null;
      if (op.recipe) {
        const recipe = await findPublished(op.recipe, tx);
        if (!recipe) return "NOT_FOUND";
        recipeId = recipe.id;
      }
      await shopping.addEntry(userId, { name: op.name, amount: op.amount, recipeId }, tx);
      return null;
    }
    case "shopping.remove":
      await shopping.removeItemByName(userId, op.name, tx);
      return null;
    case "shopping.check":
      await shopping.setCheckedByName(userId, op.name, op.checked, tx);
      return null;
    case "shopping.removeDish":
      await shopping.removeDish(userId, op.slug, tx);
      return null;
    case "shopping.clear":
      await shopping.clear(userId, tx);
      return null;
  }
}

// POST /me/sync. Клиент присылает накопленные офлайн операции, сервер применяет их в порядке
// времени действия (at) одной транзакцией и возвращает актуальное состояние целиком.
//  - заметки: last-write-wins по updatedAt — правка старше сохранённой не применяется (STALE);
//  - избранное и список покупок: операции идемпотентны, при конфликте побеждает последняя по at;
//  - at из будущего (сбитые часы клиента) обрезается до времени сервера.
// Ограничение: удаления не хранятся как «надгробия», поэтому запоздавшая старая note.set
// после note.remove с другого устройства восстановит заметку.
async function sync(userId, ops) {
  await touchActive(userId);
  const now = new Date();
  const ordered = ops
    .map((op, index) => ({ op: { ...op, at: op.at > now ? now : op.at }, index }))
    .sort((a, b) => a.op.at - b.op.at); // sort стабилен: равные at сохраняют порядок клиента

  const skipped = [];
  await prisma.$transaction(
    async (tx) => {
      for (const { op, index } of ordered) {
        const reason = await applyOp(userId, op, tx);
        if (reason) skipped.push({ index, type: op.type, reason });
      }
    },
    { timeout: 15000 }
  );
  skipped.sort((a, b) => a.index - b.index);

  const [favorites, notes, items] = await Promise.all([
    me.listFavorites(userId),
    me.listNotes(userId),
    shopping.list(userId),
  ]);
  return {
    serverTime: new Date(),
    applied: ops.length - skipped.length,
    skipped,
    favorites,
    notes,
    shopping: items,
  };
}

module.exports = { sync };
