const { z } = require("zod");

const entry = z.object({
  name: z.string().trim().min(1, "Укажите название").max(120),
  amount: z.string().trim().max(200).optional(),
  recipe: z.string().min(1).max(200).nullish(), // slug блюда; пусто — добавлено вручную
});

const addItems = z.object({ items: z.array(entry).min(1).max(100) });
const patchItem = z.object({ checked: z.boolean() });
const itemId = z.object({ id: z.uuid("Некорректный id позиции") });

module.exports = { entry, addItems, patchItem, itemId };
