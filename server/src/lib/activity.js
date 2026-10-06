// Отметка «последнее действие» (вход, синхронизация, отправка предложения): по ней cleanup удаляет аккаунты,
// в которых за 30 дней так ничего и не было. Пишем не чаще раза в час — sync вызывается очень часто.
const prisma = require("./prisma");
const logger = require("./logger");

const HOUR = 60 * 60 * 1000;

async function touchActive(userId) {
  try {
    await prisma.user.updateMany({
      where: { id: userId, OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: new Date(Date.now() - HOUR) } }] },
      data: { lastActiveAt: new Date() },
    });
  } catch (err) {
    logger.warn({ err: err.message }, "не удалось отметить активность"); // не ломаем запрос из-за служебной отметки
  }
}

module.exports = { touchActive };
