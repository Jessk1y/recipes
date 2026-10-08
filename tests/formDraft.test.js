// Автосохранение формы рецепта: чистая логика js/lib/formDraft.js с поддельным хранилищем (браузера нет).
import test from "node:test";
import assert from "node:assert/strict";
import { DRAFT_TTL_MS, draftKey, contentKey, syncDraft, loadDraft, clearDraft, draftRecipe } from "../js/lib/formDraft.js";

const fakeStore = () => {
  const m = new Map();
  return {
    get: (k, def) => (m.has(k) ? JSON.parse(m.get(k)) : def),
    set: (k, v) => m.set(k, JSON.stringify(v)),
    remove: (k) => m.delete(k),
    raw: m,
  };
};
const input = (extra = {}) => ({
  title: "Борщ", category: "Супы", main: ["Первое"], tags: [], image: null, time: "1 ч", servings: null,
  ingredients: [{ kind: "ITEM", name: "Свёкла", amount: "2 шт" }], steps: [{ kind: "ITEM", text: "Варить 40 мин" }], ...extra,
});

test("ключ: разные пользователи, режимы и рецепты не пересекаются", () => {
  const k = (a) => draftKey(a);
  assert.equal(k({ uid: "u1", mode: "user", id: undefined }), "draft:u1:my:new");
  assert.equal(k({ uid: "u1", mode: "admin", id: "r1" }), "draft:u1:admin:r1");
  assert.equal(k({ uid: "u1", mode: "moderate", id: "r1" }), "draft:u1:review:r1");
  assert.equal(new Set([k({ uid: "u1", mode: "admin", id: "r1" }), k({ uid: "u2", mode: "admin", id: "r1" }), k({ uid: "u1", mode: "admin", id: "r2" }), k({ uid: "u1", mode: "moderate", id: "r1" })]).size, 4);
  assert.equal(k({ mode: "user" }), "draft:anon:my:new");
});

test("syncDraft: отличается от исходного — сохраняет; вернулось к исходному — черновик удаляется", () => {
  const s = fakeStore(), key = "draft:u:my:new", base = contentKey(input());
  assert.equal(syncDraft(s, key, input(), base, null), false);
  assert.equal(s.raw.size, 0, "без изменений черновика нет");
  assert.equal(syncDraft(s, key, input({ title: "Борщ с фасолью" }), base, "v1", 1000), true);
  assert.deepEqual(s.get(key), { input: input({ title: "Борщ с фасолью" }), base: "v1", savedAt: 1000 });
  syncDraft(s, key, input(), base, "v1");
  assert.equal(s.raw.size, 0, "правки откатили — черновик убран");
});

test("loadDraft: свежий отдаётся; просроченный, битый и совпадающий с исходным — удаляются", () => {
  const s = fakeStore(), key = "draft:u:my:new", base = contentKey(input());
  const now = 10 * DRAFT_TTL_MS;
  syncDraft(s, key, input({ title: "Новый" }), base, null, now - 1000);
  assert.equal(loadDraft(s, key, base, now).input.title, "Новый");
  assert.equal(s.raw.size, 1, "чтение не стирает");

  syncDraft(s, key, input({ title: "Старый" }), base, null, now - DRAFT_TTL_MS - 1);
  assert.equal(loadDraft(s, key, base, now), null);
  assert.equal(s.raw.size, 0, "просроченный удалён");

  s.set(key, { oops: true });
  assert.equal(loadDraft(s, key, base, now), null);
  assert.equal(s.raw.size, 0, "битый удалён");

  s.set(key, { input: input(), savedAt: now - 5 });
  assert.equal(loadDraft(s, key, base, now), null, "совпал с исходным — предлагать нечего");
  assert.equal(s.raw.size, 0);
  assert.equal(loadDraft(s, "нет", base, now), null);
});

test("clearDraft после успешного сохранения убирает черновик", () => {
  const s = fakeStore(), key = "draft:u:admin:r1";
  syncDraft(s, key, input({ title: "Правка" }), contentKey(input()), null);
  assert.equal(s.raw.size, 1);
  clearDraft(s, key);
  assert.equal(s.raw.size, 0);
  assert.equal(loadDraft(s, key, contentKey(input())), null);
});

test("draftRecipe: поля формы из черновика, служебные из исходного рецепта; новый рецепт получает значения по умолчанию", () => {
  const base = { id: "r1", slug: "borsch", status: "PENDING", updatedAt: "t", title: "Старое", category: { name: "Супы" }, main: [], tags: [], ingredients: [], steps: [], image: "a.jpg" };
  const r = draftRecipe(base, input({ title: "Новое", image: null, slug: "novoe" }));
  assert.equal(r.id, "r1");
  assert.equal(r.status, "PENDING");
  assert.equal(r.title, "Новое");
  assert.equal(r.slug, "novoe");
  assert.equal(r.image, null, "фото убрали — так и восстановится");
  assert.deepEqual(r.category, { name: "Супы" });
  assert.equal(r.ingredients[0].name, "Свёкла");
  const fresh = draftRecipe(null, input());
  assert.equal(fresh.status, "DRAFT");
  assert.equal(fresh.slug, "");
  assert.equal(fresh.time, "1 ч");
  assert.equal(draftRecipe(null, input({ status: "PUBLISHED" })).status, "PUBLISHED");
});
