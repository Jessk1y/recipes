// Тесты разбора и сложения количеств: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { parseAmount, sumAmounts } from "../js/lib/qty.js";
import { productInfo, canonKey } from "../js/lib/products.js";

const sum = (list, name) => sumAmounts(list, name ? productInfo(name) : {}).text;
const one = (s) => parseAmount(s)[0];

test("числа: целые, запятая, дроби, юникод-дроби, смешанные", () => {
  assert.deepEqual(one("200 г"), { dim: "g", lo: 200, hi: 200, src: "g" });
  assert.equal(one("1,5 л").lo, 1500);
  assert.equal(one("1.5 л").lo, 1500);
  assert.equal(one("1/2 ч. л.").lo, 2.5);
  assert.equal(one("½ ст. л.").lo, 7.5);
  assert.equal(one("1½ стакана").lo, 375);
  assert.equal(one("1 1/2 стакана").lo, 375);
  assert.equal(one("3/4 стакана").lo, 187.5);
});

test("диапазоны и приближённость", () => {
  const r = one("2–3 ст. л.");
  assert.equal(r.lo, 30); assert.equal(r.hi, 45);
  assert.equal(one("1-1,5 стакана").hi, 375);
  assert.equal(one("≈80 мл").lo, 80);
  assert.equal(one("~50 мл").lo, 50);
  assert.equal(one("около 2 шт").lo, 2);
});

test("единицы → г / мл / шт", () => {
  assert.equal(one("1 кг").lo, 1000);
  assert.equal(one("1 ст. л.").lo, 15);
  assert.equal(one("1 ст.л.").lo, 15);
  assert.equal(one("2 ч. л.").lo, 10);
  assert.equal(one("1 стакан").lo, 250);
  assert.equal(one("3 шт").dim, "pcs");
  assert.equal(one("3–4 небольшие").dim, "pcs");
  assert.equal(one("1 средняя").dim, "pcs");
});

test("вес в скобках точнее штучной меры, а у мерной единицы скобки игнорируются", () => {
  assert.deepEqual(one("1 кружка (150 г)"), { dim: "g", lo: 150, hi: 150, src: "g" });
  assert.equal(one("1 упаковка (≈400 г)").lo, 400);
  assert.equal(one("1,5 плитки (120 г)").lo, 120);
  assert.equal(one("180 мл (полбанки)").lo, 180);
  assert.equal(one("30 г (≈1/6 упаковки)").lo, 30);
  assert.equal(parseAmount("100 г (по желанию)").length, 1);
});

test("«по вкусу», «щепотка» и пометки не числа", () => {
  for (const s of ["по вкусу", "щепотка", "для жарки", "немного", "по желанию", "оставшееся от пачки"]) {
    const p = one(s);
    assert.equal(p.text, s); assert.equal(p.known, true);
  }
  assert.equal(one("2 щепотки").known, true);
  assert.equal(one("щепотка (по желанию, чтобы оттенить какао)").text, "щепотка");
});

test("нераспознанное помечается known:false", () => {
  assert.equal(one("~тарелка").known, false);
  assert.deepEqual(sumAmounts(["~тарелка"]).unknown, ["~тарелка"]);
  assert.deepEqual(parseAmount(""), []);
  assert.deepEqual(parseAmount(null), []);
});

test("сложение одной размерности и обратный вывод", () => {
  assert.equal(sum(["200 г", "300 г"]), "500 г");
  assert.equal(sum(["600 г", "500 г"]), "1,1 кг");
  assert.equal(sum(["300 мл + 200 мл"]), "500 мл");
  assert.equal(sum(["1 л", "500 мл"]), "1,5 л");
  assert.equal(sum(["1 шт", "2 шт"]), "3 шт");
  assert.equal(sum(["2–3 шт", "1 шт"]), "3–4 шт");
});

test("ложки возвращаются в ст. л. / ч. л., 3 ч. л. = 1 ст. л.", () => {
  assert.equal(sum(["1 ст. л.", "2 ст. л."]), "3 ст. л.");
  assert.equal(sum(["2–3 ст. л.", "4–5 ст. л."]), "6–8 ст. л.");
  assert.equal(sum(["1 ст. л.", "1 ч. л."]), "1 ст. л. + 1 ч. л.");
  assert.equal(sum(["1 ч. л.", "2 ч. л."]), "1 ст. л.");
  assert.equal(sum(["1/2 ч. л.", "1/2 ч. л."]), "1 ч. л.");
});

test("стаканы остаются стаканами, со склонением", () => {
  assert.equal(sum(["1 стакан"]), "1 стакан");
  assert.equal(sum(["1 стакан", "1 стакан"]), "2 стакана");
  assert.equal(sum(["1–1,5 стакана"]), "1–1,5 стакана");
  assert.equal(sum(["1 стакан", "100 мл"]), "350 мл");
});

test("штучные меры считаются только со своей мерой", () => {
  assert.equal(sum(["1 зубчик", "1–2 зубчика"]), "2–3 зубчика");
  assert.equal(sum(["5 зубчиков", "1 шт"]), "1 шт + 5 зубчиков");
});

test("г + мл: с плотностью — в одну единицу, без — раздельно", () => {
  assert.equal(sum(["200 г", "1 стакан"], "Мука"), "360 г");         // 250 мл × 0,64 = 160 г
  assert.equal(sum(["200 г", "1 стакан"], "Молоко"), "444,2 мл");     // 200 г / 1,03 + 250 мл
  assert.equal(sum(["200 г", "1 стакан"]), "200 г + 1 стакан");
  assert.equal(sum(["200 г", "1 стакан"], "Фарш"), "200 г + 1 стакан");
});

test("качественные пометки не суммируются и не дублируются", () => {
  assert.equal(sum(["по вкусу", "по вкусу", "щепотка", "щепотка"]), "по вкусу + щепотка");
  assert.equal(sum(["1 ч. л.", "по вкусу", "1 ч. л.", "щепотка (по желанию)"]), "2 ч. л. + по вкусу + щепотка");
  assert.equal(sum(["", "100 г"]), "100 г");
  assert.equal(sum([""]), "");
});

test("нормализация названий: регистр, скобки, синонимы, порядок слов", () => {
  const same = (...names) => assert.equal(new Set(names.map(canonKey)).size, 1, names.join(" | "));
  same("Яйца", "яйцо", "Яйцо куриное", "Яйцо С0 (комнатной температуры)", "ЯЙЦА КУРИНЫЕ");
  same("Мука", "мука", "Мука пшеничная");
  same("Масло сливочное", "Сливочное масло", "Сладкосливочное масло", "Сливочное масло (растопленное)");
  same("Растительное масло", "Масло растительное", "Подсолнечное масло");
  same("Лук", "Лук репчатый", "Лук репчатый крупный");
  same("Сметана", "Сметана 20%");
  same("Какао", "Какао-порошок");
  same("Картофель", "Картофель (кубиками)", "картошка");
  same("Вода", "Горячая вода", "Вода (кипяток)");
  same("Помидор", "Помидоры");
  same("Сгущёнка", "Сгущённое молоко с сахаром");
  assert.notEqual(canonKey("Яйцо (желток)"), canonKey("Яйцо"));
  assert.notEqual(canonKey("Зелёный лук"), canonKey("Лук"));
  assert.notEqual(canonKey("Кукурузный крахмал"), canonKey("Крахмал"));
  assert.notEqual(canonKey("Масло"), canonKey("Сливочное масло"));
});

test("плотности и предпочтительная единица", () => {
  assert.equal(productInfo("Мука").density, 0.64);
  assert.equal(productInfo("Молоко").pref, "ml");
  assert.equal(productInfo("Фарш").density, 0);
});
