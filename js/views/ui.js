// Состояние экрана (фильтры, открытый рецепт, множитель порций) и ссылки на элементы страницы.
// Это локальное состояние представлений — данные приложения живут в core/store.js.
import { getCatalog } from "../core/store.js";

export const state = {
  get recipes() { return getCatalog().recipes; },
  query: "",
  activeTag: null,
  sort: "new",
  maxTime: 0,      // 0 = любое
  favOnly: false,
  current: null,   // открытый рецепт
  factor: 1,       // множитель порций
};

export const els = {
  grid: document.getElementById("grid"),
  count: document.getElementById("count"),
  tags: document.getElementById("tags"),
  toolbar: document.getElementById("toolbar"),
  recent: document.getElementById("recent"),
  empty: document.getElementById("empty"),
  search: document.getElementById("search"),
  listView: document.getElementById("list-view"),
  detailView: document.getElementById("detail-view"),
  shoppingView: document.getElementById("shopping-view"),
  shoppingBadge: document.getElementById("shopping-badge"),
  accountView: document.getElementById("account-view"),
  adminView: document.getElementById("admin-view"),
  accountBtn: document.getElementById("account-btn"),
};
