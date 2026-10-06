// Редактор рецепта: строки полей ⇄ формат хранения. node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitAmount, joinAmount, ingredientRows, ingredientsOut, stepRows, stepsOut, hasTime } from "../js/lib/recipeFields.js";

test("количество: число + единица, без числа, диапазон, дробь, нестандартное", () => {
  assert.deepEqual(splitAmount("200 г"), { qty: "200", unit: "г" });
  assert.deepEqual(splitAmount("1,5 ст. л."), { qty: "1,5", unit: "ст. л." });
  assert.deepEqual(splitAmount("щепотка"), { qty: "", unit: "щепотка" });
  assert.deepEqual(splitAmount("2–3 шт"), { qty: "2–3", unit: "шт" });
  assert.deepEqual(splitAmount("1/2 пучка"), { qty: "1/2", unit: "пучка" });
  assert.deepEqual(splitAmount("180 мл (полбанки)"), { qty: "180", unit: "мл (полбанки)" });
  assert.deepEqual(splitAmount(null), { qty: "", unit: "" });
  assert.equal(joinAmount("200", "г"), "200 г");
  assert.equal(joinAmount("", "по вкусу"), "по вкусу");
  assert.equal(joinAmount("", ""), null);
});

test("время в шаге", () => {
  assert.ok(hasTime("Выпекать 30–40 минут"));
  assert.ok(hasTime("Варить 15 мин"));
  assert.ok(!hasTime("Перемешать"));
});

// формат data/recipes.json → формат API (как server/src/lib/recipeIO.js)
const toApi = (r) => ({
  ingredients: r.ingredients.map((x) => {
    if (typeof x === "object") return { kind: "HEADER", name: x.h, amount: null };
    const i = x.indexOf(" — ");
    return i < 0 ? { kind: "ITEM", name: x.trim(), amount: null } : { kind: "ITEM", name: x.slice(0, i).trim(), amount: x.slice(i + 3).trim() };
  }),
  steps: r.steps.map((x) => (typeof x === "object" ? { kind: "HEADER", text: x.h } : { kind: "ITEM", text: x })),
});

const recipes = JSON.parse(readFileSync(new URL("../data/recipes.json", import.meta.url), "utf8"));
const list = Array.isArray(recipes) ? recipes : recipes.recipes;

test(`все ${list.length} рецептов открываются и сохраняются без потерь`, () => {
  assert.equal(list.length, 19);
  for (const r of list) {
    const api = toApi(r);
    const norm = (a) => a.map((x) => (x.kind === "ITEM" ? { ...x, amount: x.amount ?? null } : { kind: x.kind, name: x.name }));
    assert.deepEqual(ingredientsOut(ingredientRows(api.ingredients)), norm(api.ingredients), r.id);
    assert.deepEqual(stepsOut(stepRows(api.steps)), api.steps, r.id);
  }
});

test("правка количества собирается заново, ручной таймер живёт до правки текста", () => {
  const rows = ingredientRows([{ kind: "ITEM", name: "Мука", amount: "200г" }]);
  assert.equal(ingredientsOut(rows)[0].amount, "200г"); // не тронули — как было
  rows[0].unit = "кг";
  assert.equal(ingredientsOut(rows)[0].amount, "200 кг");
  const st = stepRows([{ kind: "ITEM", text: "Варить", timerSeconds: 600 }]);
  assert.equal(stepsOut(st)[0].timerSeconds, 600);
  st[0].text = "Варить долго";
  assert.equal(stepsOut(st)[0].timerSeconds, undefined);
});

test("пустые строки отбрасываются", () => {
  assert.deepEqual(ingredientsOut([{ h: false, name: "  ", qty: "1", unit: "", orig: null, origQty: "", origUnit: "" }]), []);
  assert.deepEqual(stepsOut([{ h: true, text: "" }]), []);
});
