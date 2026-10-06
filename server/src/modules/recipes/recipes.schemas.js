const { z } = require("zod");
const MAIN_TAGS = require("../../lib/mainTags");

const kind = z.enum(["ITEM", "HEADER"]).default("ITEM");
const optionalText = (max) =>
  z.string().trim().max(max).nullish().transform((v) => v || null);

const ingredient = z.object({
  kind,
  name: z.string().trim().min(1, "Пустое название").max(200),
  amount: optionalText(100),
});

const step = z.object({
  kind,
  text: z.string().trim().min(1, "Пустой шаг").max(2000),
  // если не задан — сервер определит по тексту («15 мин» → 900)
  timerSeconds: z.number().int().min(1).max(86400).nullish(),
});

const recipeShape = z.object({
    slug: z.string().max(100).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Только латиница, цифры и дефисы").optional(),
    title: z.string().trim().min(1, "Укажите название").max(200),
    category: z.string().trim().min(1, "Укажите категорию").max(50),
    main: z.array(z.enum(MAIN_TAGS)).max(MAIN_TAGS.length).default([]),
    tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
    image: z
      .string()
      .trim()
      .max(500)
      .regex(/^(https?:\/\/|images\/|\/uploads\/)/, "Ожидается URL, images/… или /uploads/…")
      .nullish()
      .transform((v) => v || null),
    time: optionalText(50),
    servings: optionalText(100),
    ingredients: z.array(ingredient).min(1, "Нужен хотя бы один ингредиент").max(100),
    steps: z.array(step).min(1, "Нужен хотя бы один шаг").max(100),
    status: z.enum(["DRAFT", "PUBLISHED"]).default("DRAFT"),
  });

// общие проверки для рецепта админа и предложения пользователя
const withContent = (schema) =>
  schema
    .refine((r) => r.ingredients.some((i) => i.kind === "ITEM"), {
      path: ["ingredients"],
      message: "Нужен хотя бы один ингредиент, а не только подзаголовки",
    })
    .refine((r) => r.steps.some((s) => s.kind === "ITEM"), {
      path: ["steps"],
      message: "Нужен хотя бы один шаг, а не только подзаголовки",
    });

const recipeInput = withContent(recipeShape);

const statusInput = z.object({ status: z.enum(["DRAFT", "PUBLISHED"]) });

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  main: z.string().max(200).optional(), // один или несколько через запятую (логическое И)
  category: z.string().max(50).optional(), // slug
  maxTime: z.coerce.number().int().min(1).max(100000).optional(),
  sort: z.enum(["new", "time", "title"]).default("new"),
  status: z.enum(["PUBLISHED", "DRAFT", "all"]).optional(), // не-PUBLISHED — только админу; all = DRAFT + PUBLISHED (предложения — в /admin/submissions)
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const randomQuery = z.object({ main: z.string().max(200).optional() });

module.exports = { recipeShape, withContent, recipeInput, statusInput, listQuery, randomQuery };
