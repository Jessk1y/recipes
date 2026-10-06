// Публичные настройки сервера (GET /config). Сейчас одна: mailEnabled — работает ли почта.
// Без почты (production без ключей Brevo/Mailjet) сервер считает всех подтверждёнными и не умеет сбрасывать пароль
// письмом, поэтому фронтенд прячет «Забыли пароль?» и подсказки про подтверждение e-mail.
// Значение запоминается на устройстве; пока ответа нет — считаем почту включённой (так было до флага).
import { LS } from "./storage.js";
import * as endpoints from "../api/endpoints.js";

let cfg = LS.get("config", null) || { mailEnabled: true };

export const mailEnabled = () => cfg.mailEnabled !== false;

// Возвращает true, если режим почты изменился (экран аккаунта стоит перерисовать)
export async function loadServerConfig() {
  try {
    const c = await endpoints.serverConfig();
    const changed = (c.mailEnabled !== false) !== mailEnabled();
    cfg = { mailEnabled: c.mailEnabled !== false };
    LS.set("config", cfg);
    return changed;
  } catch (e) {
    return false; // сервер спит/недоступен — остаёмся на сохранённом значении
  }
}
