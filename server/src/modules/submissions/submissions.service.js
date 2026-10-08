// Предложения рецептов: пользователь отправляет рецепт, админ одобряет/отклоняет.
// Предложение — обычный Recipe с submittedAt: PENDING → PUBLISHED | REJECTED (→ после правки автора снова PENDING).
// Все запросы автора ограничены authorId; чужое предложение отвечает 404 (существование не раскрываем).
const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const { AppError } = require("../../lib/errors");
const { slugify } = require("../../lib/slug");
const recipes = require("../recipes/recipes.service");
const push = require("../../lib/push");
const batch = require("../../lib/submissionBatch");
const { touchActive } = require("../../lib/activity");

const DAY = 24 * 60 * 60 * 1000;
const EDITABLE = ["PENDING", "REJECTED"];

const view = (r) => ({
  ...recipes.toFull(r),
  submittedAt: r.submittedAt,
  rejectReason: r.status === "REJECTED" ? r.rejectReason : null,
  reviewedAt: r.reviewedAt,
  // админ правит предложение без публикации: у автора оно временно заблокировано (только у PENDING)
  adminEditedAt: r.status === "PENDING" ? r.adminEditedAt : null,
});

// Пуш админам с подпиской: в очереди появилась новая отправка. Не чаще раза в 10 минут — остальные склеиваются
// в «N новых предложений» (lib/submissionBatch.js). В фоне: автор не ждёт ни push-сервисы, ни автора из БД.
function announce(userId, r, resubmitted) {
  push.background(async () => {
    const author = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
    await batch.add({ id: r.id, title: r.title, author: author && author.displayName, resubmitted });
  });
}

// ---------- автор ----------

const mine = (userId) => ({ authorId: userId, submittedAt: { not: null } });

async function listMine(userId) {
  const rows = await prisma.recipe.findMany({
    where: mine(userId),
    orderBy: { submittedAt: "desc" },
    take: 100,
    include: recipes.fullInclude,
  });
  return { items: rows.map(view), limitPerDay: env.SUBMISSIONS_PER_DAY };
}

async function getMine(userId, id) {
  const r = await prisma.recipe.findFirst({ where: { id: recipes.parseId(id), ...mine(userId) }, include: recipes.fullInclude });
  if (!r) throw recipes.notFound();
  return view(r);
}

// категорию создаёт только админ: пользователь выбирает из существующих
async function requireCategory(tx, name) {
  const slug = slugify(name) || "bez-kategorii";
  if (!(await tx.category.findUnique({ where: { slug }, select: { id: true } }))) {
    throw new AppError(422, "VALIDATION_ERROR", "Некорректные данные запроса", [
      { field: "category", message: "Выберите существующую категорию" },
    ]);
  }
}

// «остальные отправки + эта ≤ лимита»: в окне 24 ч; блокировка по пользователю делает проверку устойчивой к гонке
async function checkLimit(tx, userId, exceptId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"submit:" + userId}))`;
  const since = new Date(Date.now() - DAY);
  const recent = await tx.recipe.findMany({
    where: { authorId: userId, submittedAt: { gt: since }, ...(exceptId && { id: { not: exceptId } }) },
    orderBy: { submittedAt: "asc" },
    select: { submittedAt: true },
  });
  if (recent.length >= env.SUBMISSIONS_PER_DAY) {
    const retryAt = new Date(recent[recent.length - env.SUBMISSIONS_PER_DAY].submittedAt.getTime() + DAY);
    throw new AppError(429, "SUBMISSION_LIMIT", `Не больше ${env.SUBMISSIONS_PER_DAY} предложений в сутки. Попробуйте после ${retryAt.toISOString()}`, { retryAt });
  }
}

async function create(userId, input) {
  const out = await recipes.write(null, { ...input, status: "PENDING" }, userId, {
    before: async (tx) => {
      await checkLimit(tx, userId, null);
      await requireCategory(tx, input.category);
    },
    data: { submittedAt: new Date(), rejectReason: null },
  });
  const r = await getMine(userId, out.id);
  await touchActive(userId);
  announce(userId, r, false);
  return r;
}

async function update(userId, id, input) {
  recipes.parseId(id);
  const data = {}; // before() дополняет: повторная отправка после отказа
  const out = await recipes.write(id, { ...input, status: "PENDING" }, null, {
    before: async (tx) => {
      // блокировка строки: пока автор правит, админ не успеет её одобрить; а правка после решения получит 409
      const rows = await tx.$queryRaw`SELECT status::text AS status, admin_edited_at AS "adminEditedAt" FROM recipes
        WHERE id = ${id}::uuid AND author_id = ${userId}::uuid AND submitted_at IS NOT NULL FOR UPDATE`;
      if (!rows.length) throw recipes.notFound();
      if (!EDITABLE.includes(rows[0].status)) throw new AppError(409, "NOT_EDITABLE", "Предложение уже рассмотрено — править его нельзя");
      if (rows[0].status === "PENDING" && rows[0].adminEditedAt) {
        throw new AppError(409, "ADMIN_EDITING", "Администратор вносит правки в это предложение — пока править его нельзя. Дождитесь решения.");
      }
      await requireCategory(tx, input.category);
      if (rows[0].status === "REJECTED") {
        // повторная отправка после отказа считается новой отправкой; правка ожидающего — нет
        await checkLimit(tx, userId, id);
        Object.assign(data, { submittedAt: new Date(), rejectReason: null, adminEditedAt: null });
      }
    },
    data,
  });
  const r = await getMine(userId, out.id);
  await touchActive(userId);
  if (data.submittedAt) announce(userId, r, true); // правка отклонённого = новая отправка на модерацию; правка ожидающего — тишина
  return r;
}

// ---------- админ ----------

async function queue({ page, limit }) {
  const where = { status: "PENDING", submittedAt: { not: null } };
  const [total, rows] = await prisma.$transaction([
    prisma.recipe.count({ where }),
    prisma.recipe.findMany({
      where,
      orderBy: { submittedAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
      include: { ...recipes.fullInclude, author: { select: { id: true, displayName: true, email: true } } },
    }),
  ]);
  return {
    items: rows.map((r) => ({ ...view(r), author: r.author })),
    page,
    limit,
    total,
  };
}

async function decide(id, data) {
  const now = new Date();
  const res = await prisma.recipe.updateMany({
    where: { id: recipes.parseId(id), status: "PENDING", submittedAt: { not: null } },
    data: { ...data, reviewedAt: now, updatedAt: now },
  });
  if (!res.count) {
    const r = await prisma.recipe.findFirst({ where: { id, submittedAt: { not: null } }, select: { id: true } });
    if (!r) throw recipes.notFound();
    throw new AppError(409, "NOT_PENDING", "Предложение уже рассмотрено");
  }
  const r = await prisma.recipe.findUnique({ where: { id }, include: recipes.fullInclude });
  return view(r);
}

// при одобрении рецепт попадает в начало ленты «новое» (createdAt = момент публикации)
const approve = (id) => decide(id, { status: "PUBLISHED", rejectReason: null, createdAt: new Date() });
// при отказе блокировка автора снимается: он снова может исправить и отправить
const reject = (id, reason) => decide(id, { status: "REJECTED", rejectReason: reason, adminEditedAt: null });

// Админ сохраняет правки предложения БЕЗ публикации: остаётся PENDING, ставится adminEditedAt (автор больше не правит).
// Условный UPDATE ... WHERE status=PENDING берёт блокировку строки: одновременные решение/правка автора ждут и видят итог.
async function saveEdits(id, input) {
  recipes.parseId(id);
  const out = await recipes.write(id, { ...input, status: "PENDING" }, null, {
    before: async (tx) => {
      const res = await tx.recipe.updateMany({
        where: { id, status: "PENDING", submittedAt: { not: null } },
        data: { adminEditedAt: new Date() },
      });
      if (!res.count) {
        const r = await tx.recipe.findFirst({ where: { id, submittedAt: { not: null } }, select: { id: true } });
        if (!r) throw recipes.notFound();
        throw new AppError(409, "NOT_PENDING", "Предложение уже рассмотрено");
      }
    },
    data: {}, // не «правка админа с публикацией»: статус и дата отправки не трогаем
  });
  return view(await prisma.recipe.findUnique({ where: { id: out.id }, include: recipes.fullInclude }));
}

module.exports = { listMine, getMine, create, update, queue, approve, reject, saveEdits };
