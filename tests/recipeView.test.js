// Страница рецепта и предпросмотр в редакторе: общий код (recipeView.js), предпросмотр без побочных эффектов,
// подсказки о недочётах. Браузера нет — root подменяется простым заглушечным DOM. node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recipeViewHTML, mountRecipeView } from "../js/views/recipeView.js";
import { recipeHints, ingredientRows, stepRows } from "../js/lib/recipeFields.js";

const R = {
  id: "borsch", title: "Борщ", category: "Супы", main: ["Первое"], tags: ["свёкла"], image: "blob:x", time: "1 ч", servings: "4 порции",
  ingredients: [{ h: "Основа" }, "Свёкла — 2 шт", "Вода — 2 л"],
  steps: ["Нарезать", "Варить 30 мин", { h: "Подача" }, "Подавать"],
};

// ---- заглушка DOM: элементы запоминают обработчики, селекторы разрешаются по HTML ----
function el(over = {}) {
  const ls = {};
  const cls = new Set(over.classes || []);
  const kids = {};
  return {
    dataset: over.dataset || {}, innerHTML: "", value: "",
    classList: {
      toggle(c, on) { const v = on === undefined ? !cls.has(c) : on; if (v) cls.add(c); else cls.delete(c); },
      contains: (c) => cls.has(c),
    },
    addEventListener(ev, fn) { (ls[ev] ||= []).push(fn); },
    fire(ev, e = {}) { (ls[ev] || []).forEach((f) => f({ target: this, ...e })); },
    querySelector(sel) { return (kids[sel] ||= el()); },
    querySelectorAll() { return []; },
  };
}
function fakeRoot() {
  const queried = [];
  const cache = {};
  const root = el();
  const lists = {
    ".srv": () => [0.5, 1, 2, 3].map((f) => el({ dataset: { f: String(f) } })),
    ".ct-preset": () => [1, 5].map((m) => el({ dataset: { min: String(m) } })),
    ".ingredients-list .check-item": () => [1, 2].map((i) => el({ dataset: { ing: String(i) } })),
    ".steps-list .step-item": () => [1].map((i) => el({ dataset: { step: String(i) } })),
  };
  const singles = {
    ".ingredients-list": /ingredients-list/, "#back": /id="back"/, "#favBtn": /id="favBtn"/, "#shareBtn": /id="shareBtn"/,
    "#printBtn": /id="printBtn"/, "#toShopping": /id="toShopping"/, "#resetBtn": /id="resetBtn"/, "#noteArea": /id="noteArea"/,
    "#ctStart": /id="ctStart"/, "#ctName": /id="ctName"/, "#ctMin": /id="ctMin"/, "#ctSec": /id="ctSec"/,
  };
  root.querySelector = (sel) => {
    queried.push(sel);
    if (!singles[sel] || !singles[sel].test(root.innerHTML)) return null;
    return (cache[sel] ||= el());
  };
  root.querySelectorAll = (sel) => {
    queried.push(sel);
    return (cache[sel] ||= (lists[sel] ? lists[sel]() : []));
  };
  root.queried = queried;
  root.cache = cache;
  return root;
}
const spyTimers = () => {
  const calls = [];
  return { calls, bind: () => calls.push("bind"), addCustom: () => calls.push("add"), startCustom: (s) => calls.push("start" + s) };
};
const fxSpy = () => {
  const calls = [];
  const f = { calls };
  for (const k of ["back", "fav", "share", "print", "shop", "reset", "note", "check", "factor"]) f[k] = (...a) => calls.push([k, ...a]);
  return f;
};

test("предпросмотр: нет кнопок избранного/корзины/«назад», id не дублируют форму, заметки закрыты", () => {
  const html = recipeViewHTML(R, { preview: true, checks: { ing: { 1: 1 } }, fav: true, note: "секрет" });
  for (const id of ["back", "favBtn", "shareBtn", "printBtn", "toShopping", "resetBtn", "noteArea", "ingList", "stepList"]) {
    assert.ok(!html.includes(`id="${id}"`), "в предпросмотре не должно быть #" + id);
  }
  assert.match(html, /<textarea class="note-area" disabled/);
  assert.ok(!html.includes("секрет"), "чужая заметка не попадает в предпросмотр");
  assert.ok(!/check-item checked/.test(html), "сохранённые отметки не применяются");
  assert.match(html, /Свёкла/);
  assert.match(html, /timer-btn/); // таймер шага «30 мин» на месте
  assert.match(html, /sub-head/);
});

test("настоящая страница: кнопки, заметка, отметки и избранное на месте", () => {
  const html = recipeViewHTML(R, { checks: { ing: { 1: 1 }, step: { 0: 1 } }, fav: true, note: "мало соли" });
  for (const id of ["back", "favBtn", "shareBtn", "printBtn", "toShopping", "resetBtn", "noteArea", "ingList", "stepList"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.match(html, /★ В избранном/);
  assert.match(html, /мало соли/);
  assert.match(html, /check-item checked/);
  assert.match(html, /step-item checked/);
});

test("предпросмотр: клики по отметкам, порциям — ни одного эффекта, localStorage не тронут, таймеры работают", () => {
  let storage = 0;
  globalThis.localStorage = new Proxy({}, { get() { storage++; return () => null; }, set() { storage++; return true; } });
  try {
    const root = fakeRoot(), timers = spyTimers(), fx = fxSpy();
    // даже если вызывающий по ошибке передал fx — в предпросмотре он игнорируется
    mountRecipeView(root, R, { preview: true, timers, fx, checks: { ing: { 1: 1 } }, fav: true, note: "x" });
    for (const sel of ["#back", "#favBtn", "#shareBtn", "#printBtn", "#toShopping", "#resetBtn", "#noteArea"]) {
      assert.ok(!root.queried.includes(sel), "предпросмотр не должен привязывать " + sel);
    }
    root.cache[".ingredients-list .check-item"].forEach((li) => li.fire("click"));
    root.cache[".srv"].forEach((b) => b.fire("click"));
    root.cache[".steps-list .step-item"].forEach((li) => li.querySelector(".step-text").fire("click"));
    assert.deepEqual(fx.calls, [], "fx не вызывался");
    assert.equal(storage, 0, "localStorage не использовался");
    // масштаб порций сработал: список ингредиентов перерисован
    assert.match(root.cache[".ingredients-list"].innerHTML, /Свёкла/);
    // таймеры работают
    assert.deepEqual(timers.calls, ["bind"]);
    root.cache["#ctStart"].fire("click");
    root.cache[".ct-preset"][1].fire("click");
    assert.deepEqual(timers.calls, ["bind", "add", "start300"]);
  } finally {
    delete globalThis.localStorage;
  }
});

test("настоящая страница: клики доходят до действий", () => {
  const root = fakeRoot(), timers = spyTimers(), fx = fxSpy();
  mountRecipeView(root, R, { timers, fx, checks: {}, fav: false, note: "" });
  root.cache["#favBtn"].fire("click");
  root.cache["#toShopping"].fire("click");
  root.cache["#resetBtn"].fire("click");
  root.cache["#noteArea"].fire("input", { target: { value: "вкусно" } });
  root.cache[".ingredients-list .check-item"][0].fire("click");
  root.cache[".steps-list .step-item"][0].querySelector(".step-text").fire("click");
  root.cache[".srv"][2].fire("click"); // 2×
  assert.deepEqual(fx.calls.map((c) => c[0]), ["fav", "shop", "reset", "note", "check", "check", "factor"]);
  assert.deepEqual(fx.calls[1], ["shop", 1]);
  assert.deepEqual(fx.calls[3], ["note", "вкусно"]);
  assert.deepEqual(fx.calls[4].slice(0, 2), ["check", "ing"]);
  assert.deepEqual(fx.calls[6], ["factor", 2]);
});

test("защита от регрессий: модуль страницы и редактор не импортируют действия, синхронизацию просмотров, корзину", () => {
  const imports = (file) =>
    [...readFileSync(new URL("../js/" + file, import.meta.url), "utf8").matchAll(/^import .* from "(.+)";/gm)].map((m) => m[1]);
  assert.deepEqual(imports("views/recipeView.js"), ["../lib/utils.js"]);
  const form = imports("views/recipeForm.js").join(" ");
  for (const bad of ["core/actions", "sync/views", "views/list", "views/shopping", "views/detail", "core/storage"]) {
    assert.ok(!form.includes(bad), "recipeForm.js не должен импортировать " + bad);
  }
});

test("подсказки: всё заполнено — пусто", () => {
  const f = {
    title: "Борщ", main: ["Первое"], image: "/x.jpg", time: "1 ч", servings: "4",
    ing: ingredientRows([{ kind: "ITEM", name: "Вода", amount: "2 л" }]),
    steps: stepRows([{ kind: "ITEM", text: "Варить 30 мин" }]),
  };
  assert.deepEqual(recipeHints(f), []);
});

test("подсказки: нет фото, пустые шаги и ингредиенты, время не распознано", () => {
  const f = {
    title: "Борщ", main: [], image: null, time: "", servings: "",
    ing: ingredientRows([{ kind: "ITEM", name: "Вода", amount: "2 л" }]).concat([{ h: false, name: "  ", qty: "", unit: "" }]),
    steps: stepRows([
      { kind: "ITEM", text: "Варить полчаса" }, { kind: "ITEM", text: "" },
      { kind: "ITEM", text: "Часть мяса нарезать" }, { kind: "ITEM", text: "Томить 10 мин" },
    ]),
  };
  const h = recipeHints(f).join("\n");
  assert.match(h, /Нет фото/);
  assert.match(h, /основной тег/);
  assert.match(h, /время приготовления/);
  assert.match(h, /порции/);
  assert.match(h, /Пустых строк в ингредиентах: 1/);
  assert.match(h, /Шаг 1: упоминается время/);
  assert.match(h, /Шаг 2 пустой/);
  assert.ok(!/Шаг 3/.test(h) && !/Шаг 4/.test(h), "«часть» и «10 мин» — не замечания");
});

test("подсказки: пустой рецепт", () => {
  const h = recipeHints({ title: " ", main: [], ing: [], steps: [] }).join("\n");
  assert.match(h, /Не указано название/);
  assert.match(h, /Нет ни одного ингредиента/);
  assert.match(h, /Нет ни одного шага/);
});
