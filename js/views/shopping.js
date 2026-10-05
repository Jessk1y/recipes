// ---------- Список покупок ----------
// Единый список; каждая позиция хранит вклады блюд contribs [{r: id рецепта, a: количество}].
import { state, els } from "./ui.js";
import { getData } from "../core/store.js";
import * as actions from "../core/actions.js";
import { esc, toast } from "../lib/utils.js";

function shoppingAmount(it) {
  const seen = [];
  (it.contribs || []).forEach((c) => { if (c.a && !seen.includes(c.a)) seen.push(c.a); });
  return seen.join(" + ");
}
function shoppingText(it) { const a = shoppingAmount(it); return a ? it.name + " — " + a : it.name; }
function dishesInCart() {
  const ids = [];
  getData().shopping.forEach((it) => (it.contribs || []).forEach((c) => { if (c.r && !ids.includes(c.r)) ids.push(c.r); }));
  return ids;
}

function addToShopping(r, factor) {
  const added = actions.addRecipeToShopping(r, factor);
  updateShoppingBadge();
  toast(added ? "Добавлено в список 🛒" : "Уже в списке");
}
function removeDish(id) {
  actions.removeDish(id);
  updateShoppingBadge();
  renderShopping();
}
function addDishFromCart(id) {
  const r = state.recipes.find((x) => x.id === id);
  if (r) { addToShopping(r, 1); renderShopping(); }
}
function updateShoppingBadge() {
  const n = getData().shopping.length;
  els.shoppingBadge.hidden = n === 0;
  els.shoppingBadge.textContent = n;
}
function renderShopping() {
  const items = getData().shopping;
  const dishIds = dishesInCart();
  const chips = dishIds.map((id) => {
    const r = state.recipes.find((x) => x.id === id);
    return `<span class="dish-chip">${esc(r ? r.title : id)}<button class="dish-x" data-rmdish="${esc(id)}" title="Убрать продукты этого блюда">✕</button></span>`;
  }).join("");
  const options = state.recipes
    .filter((r) => !dishIds.includes(r.id))
    .map((r) => `<option value="${esc(r.id)}">${esc(r.title)}</option>`).join("");
  const dishBar = `<div class="cart-dishes">${chips}<select id="addDishSel" class="dish-add"><option value="">＋ добавить блюдо…</option>${options}</select></div>`;

  els.shoppingView.innerHTML = `
    <div class="detail-top">
      <button class="back-btn" id="shBack">← К списку</button>
      ${items.length ? `<button class="act-btn" id="shClear">🗑 Очистить</button>` : ""}
    </div>
    <h1 class="detail-title">🛒 Список покупок</h1>
    ${dishBar}
    ${items.length
      ? `<ul class="ingredients-list shopping-list">${items.map((it, i) =>
          `<li class="check-item${it.checked ? " checked" : ""}" data-sh="${i}"><span class="cbox"></span><span class="ctext">${esc(shoppingText(it))}</span><button class="sh-del" data-del="${i}" title="Удалить">✕</button></li>`).join("")}</ul>`
      : `<p class="empty">Список пуст. Открой рецепт и нажми «🛒 В список покупок», или добавь блюдо выше.</p>`}`;

  document.getElementById("shBack").addEventListener("click", () => { location.hash = "#"; });
  const clr = document.getElementById("shClear");
  if (clr) clr.addEventListener("click", () => {
    if (confirm("Очистить весь список покупок?")) { actions.clearShopping(); updateShoppingBadge(); renderShopping(); }
  });
  const sel = document.getElementById("addDishSel");
  if (sel) sel.addEventListener("change", () => { if (sel.value) addDishFromCart(sel.value); });
  els.shoppingView.querySelectorAll(".dish-x").forEach((b) =>
    b.addEventListener("click", () => removeDish(b.dataset.rmdish)));
  els.shoppingView.querySelectorAll(".check-item").forEach((li) => {
    const toggle = () => {
      li.classList.toggle("checked");
      actions.checkShoppingItem(items[+li.dataset.sh].name, li.classList.contains("checked"));
    };
    li.querySelector(".ctext").addEventListener("click", toggle);
    li.querySelector(".cbox").addEventListener("click", toggle);
  });
  els.shoppingView.querySelectorAll(".sh-del").forEach((b) => {
    b.addEventListener("click", () => {
      actions.removeShoppingItem(items[+b.dataset.del].name);
      updateShoppingBadge(); renderShopping();
    });
  });
}

export { addToShopping, updateShoppingBadge, renderShopping };
