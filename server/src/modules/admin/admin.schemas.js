const { z } = require("zod");

const listQuery = z.object({
  q: z.string().trim().max(100).optional(), // e-mail или имя
  role: z.enum(["USER", "ADMIN"]).optional(),
  blocked: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const userId = z.object({ id: z.uuid("Некорректный id пользователя") });
const setRole = z.object({ role: z.enum(["USER", "ADMIN"]) });
const setBlocked = z.object({ blocked: z.boolean() });

module.exports = { listQuery, userId, setRole, setBlocked };
