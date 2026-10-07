// Страница рецепта: ингредиенты (масштаб порций, вычёркивание), шаги с таймерами, свой таймер, заметки.
import { state, els } from "./ui.js";
import { isFav, getData, getChecks } from "../core/store.js";
import * as actions from "../core/actions.js";
import { toast } from "../lib/utils.js";
import { mountRecipeView } from "./recipeView.js";
import { bindTimers, addCustomTimer, startCustomTimer } from "./timers.js";
import { requestWake } from "./wake.js";
import { toggleFav } from "./list.js";
import { addToShopping } from "./shopping.js";
import { trackView } from "../sync/views.js";

function renderDetail(id) {
  const r = state.recipes.find((x) => x.id === id);
  if (!r) { location.hash = "#"; return; }
  state.current = r;
  state.factor = 1;
  actions.pushRecent(id);
  trackView(id);

  mountRecipeView(els.detailView, r, {
    timers: { bind: bindTimers, addCustom: addCustomTimer, startCustom: startCustomTimer },
    checks: getChecks()[r.id] || {},
    fav: isFav(r.id),
    note: getData().notes[r.id] || "",
    fx: {
      back: () => { location.hash = "#"; },
      fav: () => toggleFav(r.id),
      share: () => shareRecipe(r),
      print: () => window.print(),
      shop: (factor) => addToShopping(r, factor),
      reset: () => { actions.resetChecks(r.id); renderDetail(r.id); toast("Отметки сброшены ↺"); },
      note: (text) => actions.setNote(r.id, text),
      check: (kind, idx, on) => actions.toggleCheck(r.id, kind, idx, on),
      factor: (f) => { state.factor = f; },
    },
  });
  requestWake();
  window.scrollTo(0, 0);
}

// ---------- Поделиться ----------
async function shareRecipe(r) {
  const url = location.origin + location.pathname + "#/recipe/" + encodeURIComponent(r.id);
  const data = { title: r.title, text: "Рецепт: " + r.title, url };
  if (navigator.share) { try { await navigator.share(data); return; } catch (e) {} }
  try { await navigator.clipboard.writeText(url); toast("Ссылка скопирована 📋"); }
  catch (e) { prompt("Скопируй ссылку:", url); }
}

// Обновить кнопку избранного и заметку без перерисовки страницы (данные пришли с сервера/из другой вкладки):
// перерисовка сбросила бы запущенные таймеры.
function refreshDetailData() {
  const r = state.current;
  if (!r) return;
  const fav = isFav(r.id);
  const favBtn = document.getElementById("favBtn");
  if (favBtn) favBtn.textContent = fav ? "★ В избранном" : "☆ В избранное";
  const area = document.getElementById("noteArea");
  const note = getData().notes[r.id] || "";
  if (area && document.activeElement !== area && area.value !== note) area.value = note;
}

export { renderDetail, refreshDetailData };
