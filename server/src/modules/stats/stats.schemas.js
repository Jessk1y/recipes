const { z } = require("zod");

// slug как у рецептов (латиница, цифры, дефисы); лишнего в БД не ищем
const viewInput = z.object({ slug: z.string().trim().min(1).max(200).regex(/^[a-z0-9][a-z0-9-]*$/, "Некорректный slug") });
const overviewQuery = z.object({ weeks: z.coerce.number().int().min(1).max(52).default(12) });

module.exports = { viewInput, overviewQuery };
