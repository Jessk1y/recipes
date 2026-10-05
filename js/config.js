// Настройки фронтенда.

// Основные теги для фильтра на главной (в этом порядке). Тот же словарь — server/src/lib/mainTags.js.
export const MAIN_TAGS = [
  "Первое", "Второе", "Салат", "Десерт", "Напиток",
  "Курица", "Свинина", "Говядина", "Шоколад",
];

// Адрес API: при локальной разработке — сервер из server/ (npm run dev), иначе боевой на Render.
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
export const API_BASE = LOCAL ? `http://${location.hostname}:3000` : "https://recipes-api-2xgj.onrender.com";

// Бесплатный Render засыпает через 15 минут простоя и просыпается до минуты.
export const SLOW_TIMEOUT = 75_000;   // вход, синхронизация, каталог, админка
export const WAKE_HINT_AFTER = 3_000; // через сколько мс показать «сервер просыпается…»
