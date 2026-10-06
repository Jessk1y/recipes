// Подсказки продуктов в редакторе рецептов: склейка дублей, порядок, лимит. node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSuggestions, suggest, cleanName } from "../js/lib/suggest.js";

const names = (list, q, max) => suggest(buildSuggestions(list), q, max).map((e) => e.name);

test("дубли склеиваются: регистр, ё/е, синонимы, порядок слов — одно каноническое название", () => {
  const list = ["Молоко сгущенное", "Сгущённое молоко", "сгущёнка", "Сгущенка", "Яйца", "Яйцо куриное", "яйцо"];
  assert.deepEqual(names(list, "сгущ"), ["Сгущённое молоко"]);
  assert.deepEqual(names(list, "яйц"), ["Яйцо"]); // «Желток» с алиасом «яйцо (желток)» не примешивается
  assert.deepEqual(names(list, "молоко с"), ["Сгущённое молоко"]);
});

test("название не из словаря: берётся самое частое написание, с заглавной буквы", () => {
  const list = ["перец болгарский", "Болгарский перец", "Болгарский перец", "Перец болгарский"];
  const r = suggest(buildSuggestions(list), "болг");
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "Болгарский перец");
});

test("ё и е при поиске равнозначны", () => {
  assert.deepEqual(names(["Зелёный лук"], "зеле"), ["Зелёный лук"]);
  assert.equal(names(["Мёд"], "ме")[0], "Мёд");
});

test("сначала начинающиеся с введённого, потом содержащие; максимум 8", () => {
  const r = names(["Мука", "Кукурузная мука", "Мука рисовая", "Маковое семя"], "мук");
  assert.deepEqual(r.slice(0, 2), ["Мука", "Мука рисовая"].sort((a, b) => a.localeCompare(b, "ru")));
  assert.ok(r.indexOf("Кукурузная мука") > r.indexOf("Мука рисовая"));
  const many = Array.from({ length: 20 }, (_, i) => "Соус " + String.fromCharCode(1072 + i));
  assert.equal(names(many, "соус").length, 8);
  assert.equal(names(many, "соус", 3).length, 3);
});

test("описания, проценты, составные названия", () => {
  assert.equal(cleanName("Сметана 20%"), "Сметана");
  assert.equal(cleanName("Картофель (кубиками)"), "Картофель");
  assert.equal(cleanName("Сахар или растопленный мёд"), null);
  assert.equal(cleanName("Томатный соус / паста"), null);
  assert.deepEqual(names(["Сметана 20%", "Сметана"], "смет"), ["Сметана"]);
});

test("пустой запрос — пусто; точное совпадение единственного варианта — пусто", () => {
  assert.deepEqual(names(["Мука"], ""), []);
  assert.deepEqual(names([], "мука"), []);
});

test("каталог из 19 рецептов: в подсказках нет дублей по каноническому названию", () => {
  const d = JSON.parse(readFileSync(new URL("../data/recipes.json", import.meta.url), "utf8"));
  const raw = (d.recipes || d).flatMap((r) => r.ingredients).filter((i) => typeof i === "string").map((i) => i.split(" — ")[0]);
  const all = buildSuggestions(raw).map((e) => e.name.toLowerCase().replace(/ё/g, "е"));
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(suggest(buildSuggestions(raw), "яйц").map((e) => e.name), ["Яйцо"]);
  assert.deepEqual(suggest(buildSuggestions(raw), "сгущ").map((e) => e.name), ["Сгущённое молоко"]);
});

test("название, начинающееся с запроса, выше совпавшего по синониму («мол»: Молоко выше Корицы)", () => {
  const r = names([], "мол");
  assert.equal(r[0], "Молоко");
  assert.ok(r.indexOf("Корица") > r.indexOf("Молоко")); // «молотая корица» — синоним
});
