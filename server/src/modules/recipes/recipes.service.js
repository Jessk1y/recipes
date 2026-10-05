const prisma = require("../../lib/prisma");
const { AppError } = require("../../lib/errors");
const MAIN_TAGS = require("../../lib/mainTags");
const { durationSeconds, timeMinutes } = require("../../lib/duration");
const { slugify } = require("../../lib/slug");
const logger = require("../../lib/logger");
const storage = require("../../lib/storage");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AppError(404, "NOT_FOUND", "Рецепт не найден");
const slugTaken = () => new AppError(409, "SLUG_TAKEN", "Рецепт с таким slug уже существует");
const isAdmin = (user) => user?.role === "ADMIN";

const cardInclude = { category: true, tags: { include: { tag: true } } };
const fullInclude = {
  ...cardInclude,
  ingredients: { orderBy: { position: "asc" } },
  steps: { orderBy: { position: "asc" } },
};

const mainOrder = (a, b) => MAIN_TAGS.indexOf(a) - MAIN_TAGS.indexOf(b);

function toCard(r) {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    category: { id: r.category.id, name: r.category.name, slug: r.category.slug },
    main: r.tags.filter((t) => t.tag.isMain).map((t) => t.tag.name).sort(mainOrder),
    tags: r.tags.filter((t) => !t.tag.isMain).map((t) => t.tag.name).sort(),
    image: r.image,
    time: r.timeText,
    timeMinutes: r.timeMinutes,
    servings: r.servings,
    status: r.status,
    createdAt: r.createdAt,
  };
}

function toFull(r) {
  return {
    ...toCard(r),
    updatedAt: r.updatedAt,
    ingredients: r.ingredients.map((i) => ({ kind: i.kind, name: i.name, amount: i.amount })),
    steps: r.steps.map((s) => ({ kind: s.kind, text: s.text, timerSeconds: s.timerSeconds })),
  };
}

const splitList = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

async function list(q, user) {
  const status = q.status ?? "PUBLISHED";
  if (status !== "PUBLISHED" && !isAdmin(user)) {
    throw new AppError(403, "FORBIDDEN", "Черновики доступны только администратору");
  }
  const and = [];
  if (status !== "all") and.push({ status });
  if (q.category) and.push({ category: { slug: q.category } });
  if (q.maxTime) and.push({ timeMinutes: { lte: q.maxTime } });
  for (const m of splitList(q.main)) and.push({ tags: { some: { tag: { name: m, isMain: true } } } });
  if (q.q) {
    const contains = { contains: q.q, mode: "insensitive" };
    and.push({
      OR: [
        { title: contains },
        { tags: { some: { tag: { name: contains } } } },
        { ingredients: { some: { kind: "ITEM", name: contains } } },
      ],
    });
  }
  const orderBy = {
    new: [{ createdAt: "desc" }, { id: "asc" }],
    time: [{ timeMinutes: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }],
    title: [{ title: "asc" }, { id: "asc" }],
  }[q.sort];
  const where = { AND: and };

  const [total, rows] = await prisma.$transaction([
    prisma.recipe.count({ where }),
    prisma.recipe.findMany({
      where,
      orderBy,
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: cardInclude,
    }),
  ]);
  return { items: rows.map(toCard), page: q.page, limit: q.limit, total };
}

async function getBySlug(slug, user) {
  const r = await prisma.recipe.findUnique({ where: { slug }, include: fullInclude });
  if (!r || (r.status !== "PUBLISHED" && !isAdmin(user))) throw notFound();
  return toFull(r);
}

async function random({ main }) {
  const where = {
    status: "PUBLISHED",
    AND: splitList(main).map((m) => ({ tags: { some: { tag: { name: m, isMain: true } } } })),
  };
  const total = await prisma.recipe.count({ where });
  if (!total) throw notFound();
  const [r] = await prisma.recipe.findMany({
    where,
    orderBy: { id: "asc" },
    skip: Math.floor(Math.random() * total),
    take: 1,
    select: { slug: true },
  });
  return { slug: r.slug };
}

// версия каталога для ETag: меняется при любом изменении/добавлении/удалении опубликованных рецептов
async function snapshotVersion() {
  const agg = await prisma.recipe.aggregate({
    where: { status: "PUBLISHED" },
    _count: true,
    _max: { updatedAt: true },
  });
  return `${agg._count}-${agg._max.updatedAt ? agg._max.updatedAt.getTime() : 0}`;
}

async function snapshot() {
  const rows = await prisma.recipe.findMany({
    where: { status: "PUBLISHED" },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    include: fullInclude,
  });
  return { version: await snapshotVersion(), recipes: rows.map(toFull) };
}

// ---------- запись (админ) ----------

async function resolveTags(tx, input) {
  const existing = new Map((await tx.tag.findMany()).map((t) => [t.name.toLowerCase(), t]));
  const wanted = new Map();
  for (const m of input.main) wanted.set(m.toLowerCase(), { name: m, isMain: true });
  for (const t of input.tags) {
    const k = t.toLowerCase();
    if (!wanted.has(k)) wanted.set(k, { name: k, isMain: false });
  }
  const ids = [];
  for (const [k, w] of wanted) {
    const tag = existing.get(k);
    // основной тег нельзя «выдать» через свободные теги — только через поле main
    if (tag?.isMain && !w.isMain) continue;
    ids.push(tag ? tag.id : (await tx.tag.create({ data: w })).id);
  }
  return ids;
}

async function uniqueSlug(tx, base) {
  let slug = base;
  for (let n = 2; await tx.recipe.findUnique({ where: { slug }, select: { id: true } }); n++) {
    slug = `${base}-${n}`;
  }
  return slug;
}

// удаляет загруженное через API фото, если на него больше не ссылается ни один рецепт (чужие URL игнорируются)
async function releaseImage(url) {
  if (!url) return;
  try {
    if ((await prisma.recipe.count({ where: { image: url } })) === 0) await storage.remove(url);
  } catch (e) {
    logger.warn({ err: e, url }, "Не удалось удалить старое фото"); // рецепт уже сохранён — не роняем запрос
  }
}

async function write(id, input, authorId) {
  let oldImage = null;
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const category = await tx.category.upsert({
        where: { slug: slugify(input.category) || "bez-kategorii" },
        update: {},
        create: { name: input.category, slug: slugify(input.category) || "bez-kategorii" },
      });
      const tagIds = await resolveTags(tx, input);

      let slug;
      if (input.slug) {
        const clash = await tx.recipe.findUnique({ where: { slug: input.slug }, select: { id: true } });
        if (clash && clash.id !== id) throw slugTaken();
        slug = input.slug;
      } else if (!id) {
        slug = await uniqueSlug(tx, slugify(input.title) || "recipe");
      }

      const data = {
        ...(slug && { slug }),
        title: input.title,
        categoryId: category.id,
        image: input.image,
        timeText: input.time,
        timeMinutes: timeMinutes(input.time),
        servings: input.servings,
        status: input.status,
      };
      const children = {
        tags: tagIds.map((tagId) => ({ tagId })),
        ingredients: input.ingredients.map((i, position) => ({
          position,
          kind: i.kind,
          name: i.name,
          amount: i.kind === "HEADER" ? null : i.amount,
        })),
        steps: input.steps.map((s, position) => ({
          position,
          kind: s.kind,
          text: s.text,
          timerSeconds: s.kind === "HEADER" ? null : s.timerSeconds ?? (durationSeconds(s.text) || null),
        })),
      };

      let recipeId = id;
      if (id) {
        const found = await tx.recipe.findUnique({ where: { id }, select: { image: true } });
        if (!found) throw notFound();
        oldImage = found.image;
        await tx.recipeTag.deleteMany({ where: { recipeId: id } });
        await tx.ingredient.deleteMany({ where: { recipeId: id } });
        await tx.step.deleteMany({ where: { recipeId: id } });
        await tx.recipe.update({ where: { id }, data });
      } else {
        recipeId = (await tx.recipe.create({ data: { ...data, authorId } })).id;
      }
      await tx.recipeTag.createMany({ data: children.tags.map((t) => ({ recipeId, ...t })) });
      await tx.ingredient.createMany({ data: children.ingredients.map((i) => ({ recipeId, ...i })) });
      await tx.step.createMany({ data: children.steps.map((s) => ({ recipeId, ...s })) });

      return toFull(await tx.recipe.findUnique({ where: { id: recipeId }, include: fullInclude }));
    });
  } catch (e) {
    if (e.code === "P2002") throw slugTaken(); // гонка двух одновременных создателей
    throw e;
  }
  if (oldImage && oldImage !== input.image) await releaseImage(oldImage); // фото заменили — старое больше не нужно
  return result;
}

const parseId = (id) => {
  if (!UUID_RE.test(id)) throw notFound();
  return id;
};

const create = (input, user) => write(null, input, user.id);
const update = (id, input) => write(parseId(id), input);

async function setStatus(id, status) {
  try {
    const r = await prisma.recipe.update({ where: { id: parseId(id) }, data: { status } });
    return { id: r.id, status: r.status };
  } catch (e) {
    if (e.code === "P2025") throw notFound();
    throw e;
  }
}

async function remove(id) {
  const r = await prisma.recipe.findUnique({ where: { id: parseId(id) }, select: { image: true } });
  if (!r) throw notFound();
  await prisma.recipe.delete({ where: { id } });
  await releaseImage(r.image);
}

module.exports = { list, getBySlug, random, snapshot, snapshotVersion, create, update, setStatus, remove };
