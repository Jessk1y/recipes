// Каталог рецептов. Сайт открывается мгновенно: сначала показываем сохранённую копию
// (recipes:catalog) или, при самом первом визите, запасной data/recipes.json; свежий каталог
// из API (/catalog/snapshot) подтягивается в фоне. Если сервер спит или недоступен — работаем на копии.
import { LS } from "../core/storage.js";
import { dispatch, getCatalog } from "../core/store.js";
import * as endpoints from "../api/endpoints.js";
import { imageUrl } from "../api/client.js";

// Рецепт из API → формат фронтенда (как в data/recipes.json; та же логика — toJsonRecipe на сервере)
export function fromApi(r) {
  return {
    id: r.slug,
    title: r.title,
    category: r.category.name,
    tags: r.tags,
    main: r.main,
    image: imageUrl(r.image) || "",
    time: r.time || "",
    servings: r.servings || "",
    ingredients: r.ingredients.map((i) =>
      i.kind === "HEADER" ? { h: i.name } : i.amount ? `${i.name} — ${i.amount}` : i.name),
    steps: r.steps.map((s) => (s.kind === "HEADER" ? { h: s.text } : s.text)),
  };
}

function setCatalog(recipes, version, source) {
  recipes.forEach((r, i) => (r._order = i)); // новизна = позиция в массиве
  dispatch({ type: "catalog.set", recipes, version, source });
}

// Быстрый старт: копия из localStorage, иначе запасной файл. Возвращает false, если нет ни того, ни другого.
export async function loadLocalCatalog() {
  const cached = LS.get("catalog", null);
  if (cached && Array.isArray(cached.recipes) && cached.recipes.length) {
    setCatalog(cached.recipes, cached.version, "cache");
    return true;
  }
  try {
    const res = await fetch("data/recipes.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    setCatalog(await res.json(), null, "fallback");
    return true;
  } catch (e) {
    return false;
  }
}

// Фоновое обновление из API. true — каталог изменился.
let inflight = null;
export function refreshCatalog() {
  if (!inflight) {
    inflight = (async () => {
      const snap = await endpoints.snapshot();
      if (snap.version === getCatalog().version && getCatalog().source !== "fallback") return false;
      const recipes = snap.recipes.map(fromApi);
      LS.set("catalog", { version: snap.version, recipes });
      setCatalog(recipes, snap.version, "server");
      return true;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}
export const catalogLoading = () => !!inflight;
