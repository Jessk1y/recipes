// Пуши админам о предложениях рецептов — не чаще раза в окно (10 минут). Первое предложение уходит сразу
// (как раньше), следующие копятся и уходят одним уведомлением «N новых предложений».
// Очередь и таймер — в памяти: при перезапуске сервера неотправленная пачка теряется (само предложение остаётся
// в очереди модерации, потеряется только уведомление о нём).
const push = require("./push");
const env = require("../config/env");

// изменяемый объект: в тестах окно 0 (каждое предложение — отдельный пуш), как было до группировки
const config = { windowMs: env.NODE_ENV === "test" ? 0 : 10 * 60 * 1000 };

let lastSentAt = 0;
let queue = [];
let timer = null;

// 1 новое предложение, 2 новых предложения, 5 новых предложений, 21 новое предложение
function countText(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} новое предложение рецепта`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} новых предложения рецептов`;
  return `${n} новых предложений рецептов`;
}

const quote = (t) => `«${t}»`;

function payloadFor(items) {
  if (items.length === 1) {
    const it = items[0];
    return {
      title: it.resubmitted ? "Исправленное предложение рецепта" : "Новое предложение рецепта",
      body: `«${it.title}»${it.author ? ` — ${it.author}` : ""}`,
      hash: "#/admin/submissions",
      tag: `submission-${it.id}`,
    };
  }
  return {
    title: countText(items.length),
    body: items.map((i) => quote(i.title)).join(", "),
    hash: "#/admin/submissions",
    tag: "submissions-batch",
  };
}

function sendNow() {
  clearTimeout(timer);
  timer = null;
  const items = queue;
  queue = [];
  if (!items.length) return Promise.resolve();
  lastSentAt = Date.now();
  return push.background(() => push.notifyAdmins(payloadFor(items)));
}

// item: { id, title, author, resubmitted }. Возвращает промис отправки, если пуш ушёл сразу (иначе — уже завершённый)
function add(item) {
  queue.push(item);
  if (timer) return Promise.resolve();
  const wait = lastSentAt + config.windowMs - Date.now();
  if (wait <= 0) return sendNow();
  timer = setTimeout(sendNow, wait);
  timer.unref();
  return Promise.resolve();
}

// для тестов: отправить накопленное прямо сейчас / сбросить состояние
const flush = () => sendNow();
const reset = () => {
  clearTimeout(timer);
  timer = null;
  queue = [];
  lastSentAt = 0;
};

module.exports = { add, flush, reset, config, countText };
