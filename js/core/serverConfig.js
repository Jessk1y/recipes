// Публичные настройки сервера (GET /config): mailEnabled — работает ли почта; turnstileSiteKey — ключ капчи (null — выключена).
// Без почты (production без ключей Brevo/Mailjet) сервер считает всех подтверждёнными и не умеет сбрасывать пароль
// письмом, поэтому фронтенд прячет «Забыли пароль?» и подсказки про подтверждение e-mail.
// Значение запоминается на устройстве; пока ответа нет — считаем почту включённой (так было до флага).
import { LS } from "./storage.js";
import * as endpoints from "../api/endpoints.js";

let cfg = LS.get("config", null) || { mailEnabled: true };

export const mailEnabled = () => cfg.mailEnabled !== false;
// публичный ключ Cloudflare Turnstile или null, если капча на сервере выключена
export const turnstileKey = () => cfg.turnstileSiteKey || null;

// Возвращает true, если режим почты изменился (экран аккаунта стоит перерисовать)
export async function loadServerConfig() {
  try {
    const c = await endpoints.serverConfig();
    const next = { mailEnabled: c.mailEnabled !== false, turnstileSiteKey: c.turnstileSiteKey || null };
    const changed = next.mailEnabled !== mailEnabled() || next.turnstileSiteKey !== turnstileKey();
    cfg = next;
    LS.set("config", cfg);
    return changed;
  } catch (e) {
    return false; // сервер спит/недоступен — остаёмся на сохранённом значении
  }
}
