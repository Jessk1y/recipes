// Обновляет запасной каталог фронтенда data/recipes.json из /catalog/snapshot боевого API.
// Этот файл нужен только для самого первого визита без сети; источник рецептов — БД.
// Использование: npm run catalog:export [-- --api http://localhost:3000]
const fs = require("fs");
const path = require("path");
const { toJsonRecipe } = require("../src/lib/recipeIO");

const DEFAULT_API = "https://recipes-api-2xgj.onrender.com";
const OUT = path.join(__dirname, "..", "..", "data", "recipes.json");

async function main() {
  const i = process.argv.indexOf("--api");
  const api = (i > 0 ? process.argv[i + 1] : DEFAULT_API).replace(/\/$/, "");
  console.log(`Загружаю ${api}/api/v1/catalog/snapshot (бесплатный Render может просыпаться до минуты)…`);
  const res = await fetch(`${api}/api/v1/catalog/snapshot`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { version, recipes } = await res.json();
  if (!recipes.length) throw new Error("Каталог пуст — файл не перезаписан");
  fs.writeFileSync(OUT, JSON.stringify(recipes.map(toJsonRecipe), null, 2) + "\n");
  console.log(`Готово: ${recipes.length} рецептов (версия ${version}) → ${OUT}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
