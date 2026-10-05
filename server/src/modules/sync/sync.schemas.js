const { z } = require("zod");
const { entry } = require("../shopping/shopping.schemas");

const at = z.iso.datetime({ offset: true, error: "Время операции — ISO 8601" }).transform((s) => new Date(s));
const slug = z.string().min(1).max(200);
const name = z.string().trim().min(1).max(120);

// Одна запись outbox клиента. at — когда пользователь сделал действие (по часам клиента).
const op = z.discriminatedUnion("type", [
  z.object({ type: z.literal("favorite.add"), slug, at }),
  z.object({ type: z.literal("favorite.remove"), slug, at }),
  z.object({ type: z.literal("note.set"), slug, text: z.string().max(2000), at }),
  z.object({ type: z.literal("note.remove"), slug, at }),
  z.object({ type: z.literal("shopping.add"), ...entry.shape, at }),
  z.object({ type: z.literal("shopping.remove"), name, at }),
  z.object({ type: z.literal("shopping.check"), name, checked: z.boolean(), at }),
  z.object({ type: z.literal("shopping.removeDish"), slug, at }),
  z.object({ type: z.literal("shopping.clear"), at }),
]);

// 200 операций — чтобы тело уложилось в лимит express.json (100 КБ); больше — несколькими запросами
const sync = z.object({ ops: z.array(op).max(200) });

module.exports = { sync };
