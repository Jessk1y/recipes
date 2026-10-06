// Web Push администратора: подписка этого браузера через service worker.
// Сервер хранит подписку (PUT /admin/push/subscription) и шлёт пуш при новом предложении рецепта.
// iPhone: пуши работают только у сайта, добавленного на экран «Домой» (iOS 16.4+) — см. support().
import * as endpoints from "../api/endpoints.js";
import { ApiError, NetworkError } from "../api/client.js";

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);

// "ok" | "ios-install" (iPhone/iPad, сайт открыт во вкладке Safari) | "unsupported"
export function support() {
  if (isIOS() && !isStandalone()) return "ios-install";
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "ok";
  return "unsupported";
}

const keyBytes = (b64url) => {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function browserSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// Состояние для кнопки: { kind: "ios-install" | "unsupported" | "server-off" | "denied" | "off" | "on", publicKey?, endpoint? }
export async function getState() {
  const s = support();
  if (s !== "ok") return { kind: s };
  const cfg = await endpoints.pushKey();
  if (!cfg.enabled) return { kind: "server-off" };
  if (Notification.permission === "denied") return { kind: "denied" };
  const sub = Notification.permission === "granted" ? await browserSubscription() : null;
  if (!sub) return { kind: "off", publicKey: cfg.publicKey };
  // подписка могла потеряться на сервере (мёртвая удалена, другой админ вошёл на этом устройстве) — обновляем тихо
  endpoints.pushSubscribe(sub.toJSON()).catch(() => {});
  return { kind: "on", endpoint: sub.endpoint, publicKey: cfg.publicKey };
}

// Включить. Вызывать прямо из обработчика клика: iOS не покажет запрос разрешения, если до него был await.
// publicKey берём заранее (из getState), а не запрашиваем здесь.
export async function enable(publicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied"
    ? "Уведомления заблокированы в настройках браузера."
    : "Разрешение на уведомления не выдано.");
  const reg = await navigator.serviceWorker.ready;
  const options = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) };
  let sub;
  try {
    sub = await reg.pushManager.subscribe(options);
  } catch (e) {
    // подписка со старым ключом сервера (ключи меняли) — снимаем и оформляем заново
    const old = await reg.pushManager.getSubscription();
    if (!old) throw e;
    await old.unsubscribe();
    sub = await reg.pushManager.subscribe(options);
  }
  await endpoints.pushSubscribe(sub.toJSON());
  return sub.endpoint;
}

// Выключить на этом устройстве. Сбой связи с сервером не страшен: отписанный браузер вернёт 410, и подписка удалится сама.
export async function disable() {
  const sub = await browserSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  await sub.unsubscribe();
  try { await endpoints.pushUnsubscribe(endpoint); } catch (e) { /* уберётся при первой же отправке */ }
}

export const sendTest = (endpoint) => endpoints.pushTest(endpoint);

// При выходе из аккаунта: подписка принадлежит браузеру, а не человеку — отписываем устройство, пока токен действует
export async function dropPushOnLogout() {
  try {
    if (support() !== "ok" || Notification.permission !== "granted") return;
    const sub = await browserSubscription();
    if (!sub) return;
    const { endpoint } = sub;
    await sub.unsubscribe();
    await endpoints.pushUnsubscribe(endpoint, 8000);
  } catch (e) { /* выходу не мешаем */ }
}

export const pushErrorText = (e) =>
  e instanceof NetworkError ? "Нет связи с сервером, попробуйте ещё раз." : e instanceof ApiError || e instanceof Error ? e.message : "Не удалось выполнить действие.";
