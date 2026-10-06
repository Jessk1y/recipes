// Виджет Cloudflare Turnstile («я не робот») для регистрации и отправки предложения рецепта.
// Скрипт Cloudflare подгружается один раз и только когда сервер прислал публичный ключ (GET /config → turnstileSiteKey);
// без ключа (локально, выключено на сервере) форма работает без капчи.
// Токен одноразовый и живёт ~5 минут: после любой неудачной отправки виджет надо сбросить (reset).
const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading = null;

function loadScript() {
  if (window.turnstile) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { loading = null; s.remove(); reject(new Error("Не удалось загрузить проверку «я не робот». Проверьте интернет и перезагрузите страницу.")); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/**
 * Рисует виджет внутри box. Возвращает { token(), reset(), remove(), ready } :
 * token() — текущий токен или "" (ещё не пройдена / истёк), ready — промис загрузки (reject при сбое сети).
 * onChange(token) вызывается при получении и сбросе токена.
 */
export function mountTurnstile(box, siteKey, { onChange } = {}) {
  let token = "";
  let id = null;
  const set = (t) => { token = t; if (onChange) onChange(t); };
  const ready = loadScript().then(() => {
    if (!box.isConnected) return; // экран успели закрыть
    id = window.turnstile.render(box, {
      sitekey: siteKey,
      language: "ru",
      callback: (t) => set(t),
      "expired-callback": () => set(""),
      "error-callback": () => set(""),
    });
  });
  return {
    ready,
    token: () => token,
    reset() {
      set("");
      if (id !== null && window.turnstile) window.turnstile.reset(id);
    },
    remove() {
      if (id !== null && window.turnstile) window.turnstile.remove(id);
      id = null;
    },
  };
}
