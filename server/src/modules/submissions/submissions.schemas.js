const { z } = require("zod");
const storage = require("../../lib/storage");
const { recipeShape, withContent } = require("../recipes/recipes.schemas");

// slug и status пользователь не задаёт (лишние ключи отбрасываются); фото — только загруженное через наш API;
// свободных тегов не больше 10
const submissionInput = withContent(
  recipeShape.omit({ slug: true, status: true }).extend({
    tags: z.array(z.string().trim().min(1).max(40)).max(10, "Не больше 10 тегов").default([]),
    image: z
      .string()
      .trim()
      .max(500)
      .refine(storage.isOwn, "Можно использовать только фото, загруженное на сайт")
      .nullish()
      .transform((v) => v || null),
  })
);

const id = z.object({ id: z.string().max(64) }); // формат uuid проверяет сервис (чужой/кривой id → 404)
const rejectInput = z.object({ reason: z.string().trim().min(3, "Укажите причину (от 3 символов)").max(500) });
const queueQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

module.exports = { submissionInput, id, rejectInput, queueQuery };
