const { z } = require("zod");

// Адрес, на который сервер будет отправлять запросы, задаёт клиент — поэтому только https на стандартном порту
// и не localhost / IP-адрес / внутренние зоны (защита от запросов во внутреннюю сеть через украденный аккаунт админа).
function isPushUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (h.startsWith("[") || /^[\d.]+$/.test(h)) return false; // IPv6 / IPv4
  if (h === "localhost" || /\.(local|localhost|internal|lan|home)$/.test(h)) return false;
  return h.includes(".");
}

const endpoint = z.string().trim().max(1024).refine(isPushUrl, "Некорректный адрес push-подписки");
// p256dh — публичный ключ P-256 (65 байт), auth — секрет подписки (16 байт); длины проверяем по декодированному значению
const key = (bytes) =>
  z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, "Ожидается base64url")
    .refine((v) => Buffer.from(v, "base64url").length === bytes, `Ожидается ${bytes} байт`);

const subscription = z.object({
  endpoint,
  keys: z.object({ p256dh: key(65), auth: key(16) }),
});
const endpointOnly = z.object({ endpoint });

module.exports = { subscription, endpointOnly, isPushUrl };
