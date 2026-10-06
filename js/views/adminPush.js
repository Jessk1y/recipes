// Блок «Уведомления» в админке: включить/выключить/проверить push о новых предложениях рецептов.
import { esc } from "../lib/utils.js";
import { getState, enable, disable, sendTest, pushErrorText } from "../sync/push.js";

export const pushBoxHTML = () => `<div class="push-box" id="pushBox" hidden></div>`;

const IOS_HINT = `На iPhone уведомления работают только у сайта, добавленного на экран «Домой»: в Safari нажмите «Поделиться» → «На экран „Домой“», откройте сайт с новой иконки, зайдите в админку и включите уведомления.`;

function draw(box, text, buttons = [], note = "") {
  box.innerHTML = `
    <span class="push-text">${esc(text)}</span>
    ${buttons.map((b) => `<button class="tool-btn${b.accent ? " accent" : ""}" data-push="${b.id}">${esc(b.label)}</button>`).join("")}
    ${note ? `<span class="push-note">${esc(note)}</span>` : ""}`;
}

export async function mountPushBox() {
  const box = document.getElementById("pushBox");
  if (!box) return;
  box.hidden = false;
  const alive = () => box.isConnected;
  draw(box, "🔔 Проверяем уведомления…");

  const show = async () => {
    let st;
    try {
      st = await getState();
    } catch (e) {
      if (alive()) draw(box, "🔔 Не удалось проверить уведомления.", [{ id: "retry", label: "Повторить" }], pushErrorText(e));
      return st;
    }
    if (!alive()) return st;
    switch (st.kind) {
      case "ios-install": draw(box, "🔔 Уведомления", [], IOS_HINT); break;
      case "unsupported": draw(box, "🔕 Этот браузер не поддерживает push-уведомления."); break;
      case "server-off": draw(box, "🔕 Push-уведомления на сервере не настроены (нет VAPID-ключей)."); break;
      case "denied": draw(box, "🔕 Уведомления заблокированы в настройках сайта.", [], "Разрешите их в настройках браузера и обновите страницу."); break;
      case "on":
        draw(box, "🔔 Уведомления о новых предложениях включены на этом устройстве.", [{ id: "test", label: "Проверить" }, { id: "off", label: "Выключить" }]);
        break;
      default:
        draw(box, "🔔 Хотите получать уведомление, когда пользователь предложит рецепт?", [{ id: "on", label: "Включить уведомления", accent: true }]);
    }
    return st;
  };
  let state = await show();

  box.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-push]");
    if (!btn || btn.disabled) return;
    const act = btn.dataset.push;
    if (act === "retry") { draw(box, "🔔 Проверяем уведомления…"); state = await show(); return; }
    btn.disabled = true;
    try {
      if (act === "on") {
        // requestPermission — первым действием в обработчике клика (требование iOS), без await до него
        const p = enable(state.publicKey);
        draw(box, "🔔 Включаем…");
        state = { kind: "on", endpoint: await p, publicKey: state.publicKey };
        if (alive()) draw(box, "🔔 Уведомления включены на этом устройстве.", [{ id: "test", label: "Проверить" }, { id: "off", label: "Выключить" }]);
      } else if (act === "off") {
        await disable();
        state = { kind: "off", publicKey: state.publicKey };
        if (alive()) draw(box, "🔕 Уведомления выключены на этом устройстве.", [{ id: "on", label: "Включить уведомления", accent: true }]);
      } else if (act === "test") {
        btn.textContent = "Отправляем…"; // сервер ждёт ответа push-сервиса — до 10 с
        await sendTest(state.endpoint);
        btn.disabled = false;
        btn.textContent = "Отправлено ✓";
      }
    } catch (err) {
      if (!alive()) return;
      // «подписка устарела» (410) — сервер её удалил: предлагаем включить заново
      if (err && err.status === 410) await disable().catch(() => {}); // подписка в браузере тоже мёртвая
      state = (await show()) || state;
      const note = document.createElement("span");
      note.className = "push-note err";
      note.textContent = pushErrorText(err);
      box.append(note);
    }
  });
}
