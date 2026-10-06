const prisma = require("../../lib/prisma");
const { AppError } = require("../../lib/errors");

const select = { id: true, email: true, displayName: true, role: true, isBlocked: true, createdAt: true };
const notFound = () => new AppError(404, "NOT_FOUND", "Пользователь не найден");
const lastAdmin = () =>
  new AppError(409, "LAST_ADMIN", "Нельзя снять права или заблокировать последнего активного администратора");

async function listUsers({ q, role, blocked, page, limit }) {
  const where = {};
  if (role) where.role = role;
  if (blocked !== undefined) where.isBlocked = blocked;
  if (q) {
    const contains = { contains: q, mode: "insensitive" };
    where.OR = [{ email: contains }, { displayName: contains }];
  }
  const [total, items] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return { items, page, limit, total };
}

const isActiveAdmin = (u) => u.role === "ADMIN" && !u.isBlocked;

// Изменение пользователя под транзакционной advisory-блокировкой: два админа, одновременно
// лишающие друг друга прав, не смогут оставить систему без администратора.
// Если после правки целевой пользователь перестаёт быть активным админом, а других активных
// админов нет — 409 LAST_ADMIN, ничего не меняется.
async function mutate(id, change, { revokeSessions = false } = {}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('admin-guard'))`;
    const target = await tx.user.findUnique({ where: { id }, select });
    if (!target) throw notFound();

    const after = { ...target, ...change };
    if (isActiveAdmin(target) && !isActiveAdmin(after)) {
      const others = await tx.user.count({ where: { role: "ADMIN", isBlocked: false, id: { not: id } } });
      if (others === 0) throw lastAdmin();
    }
    if (Object.keys(change).every((k) => target[k] === change[k])) return target; // нечего менять

    const updated = await tx.user.update({ where: { id }, data: change, select });
    if (!isActiveAdmin(updated)) {
      // разжалованный или заблокированный перестаёт получать пуши админа
      await tx.pushSubscription.deleteMany({ where: { userId: id } });
    }
    if (revokeSessions) {
      // заблокированный теряет все refresh-токены сразу, не дожидаясь их истечения
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return updated;
  });
}

const setRole = (id, role) => mutate(id, { role });
const setBlocked = (id, blocked) => mutate(id, { isBlocked: blocked }, { revokeSessions: blocked });

module.exports = { listUsers, setRole, setBlocked };
