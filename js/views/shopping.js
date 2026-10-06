// ---------- Список покупок ----------
// Единый список; каждая позиция хранит вклады блюд contribs [{r: id рецепта, a: количество}].
import { state, els } from "./ui.js";
import { getData } from "../core/store.js";
import * as actions from "../core/actions.js";
import { esc, toast } from "../lib/utils.js";
import { productInfo } from "../lib/products.js";
import { sumAmounts } from "../lib/qty.js";

// Хранение не меняется: каждая запись — отдельное название со своими contribs.
// Сложение — только при показе: записи с одним productInfo().key («яйцо» / «яйца куриные») идут одной строкой.
function groupedItems() {
  const map = new Map();
  getData().shopping.forEach((it) => {
    const info = productInfo(it.name);
    let g = map.get(info.key);
    if (!g) { g = { name: it.name, info, items: [] }; map.set(info.key, g); }
    g.items.push(it);
  });
  return [...map.values()];
}
function groupTotal(g) {
  const amounts = g.items.flatMap((it) => (it.contribs || []).map((c) => c.a).filter(Boolean));
  return sumAmounts(amounts, g.info).text;
}
function shoppingText(g) { const a = groupTotal(g); return a ? g.name + " — " + a : g.name; }
// «Блины 200 г · Пирог 1 стакан» — только если продукт нужен минимум двум блюдам
function groupByDish(g) {
  const per = new Map();
  g.items.forEach((it) => (it.contribs || []).forEach((c) => {
    if (!c.r) return;
    if (!per.has(c.r)) per.set(c.r, []);
    if (c.a) per.get(c.r).push(c.a);
  }));
  if (per.size < 2) return "";
  return [...per].map(([id, amounts]) => {
    const r = state.recipes.find((x) => x.id === id);
    const t = sumAmounts(amounts, g.info).text;
    return (r ? r.title : id) + (t ? " " + t : "");
  }).join(" · ");
}
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
  const items = groupedItems();
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
      ? `<ul class="ingredients-list shopping-list">${items.map((g, i) => {
          const src = groupByDish(g);
          return `<li class="check-item${g.items.every((it) => it.checked) ? " checked" : ""}" data-sh="${i}"><span class="cbox"></span><span class="ctext">${esc(shoppingText(g))}${src ? `<small class="sh-src">${esc(src)}</small>` : ""}</span><button class="sh-del" data-del="${i}" title="Удалить">✕</button></li>`;
        }).join("")}</ul>`
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
      const on = li.classList.contains("checked");
      items[+li.dataset.sh].items.forEach((it) => actions.checkShoppingItem(it.name, on));
    };
    li.querySelector(".ctext").addEventListener("click", toggle);
    li.querySelector(".cbox").addEventListener("click", toggle);
  });
  els.shoppingView.querySelectorAll(".sh-del").forEach((b) => {
    b.addEventListener("click", () => {
      items[+b.dataset.del].items.forEach((it) => actions.removeShoppingItem(it.name));
      updateShoppingBadge(); renderShopping();
    });
  });
}

export { addToShopping, updateShoppingBadge, renderShopping };
