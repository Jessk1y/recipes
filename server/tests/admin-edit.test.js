// Правки предложения админом без публикации: права, блокировка автора (ADMIN_EDITING), гонки с автором и с отказом.
process.env.NODE_ENV = "test";
process.env.STORAGE_DRIVER = "local";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../src/app");
const prisma = require("../src/lib/prisma");
const limiters = require("../src/middleware/rateLimits");
const { signAccessToken } = require("../src/lib/jwt");

const T = `ae${Date.now().toString(36)}`;
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const as = (u, m, url) => api(m, url).set("Authorization", `Bearer ${u.token}`);
const CAT = `Тест ${T}`;
const U = {};

async function mkUser(name, role = "USER") {
  const u = await prisma.user.create({
    data: { email: `${name}-${T}@edit-test.example.com`, passwordHash: "x", displayName: name, role, emailVerifiedAt: new Date() },
  });
  U[name] = { id: u.id, token: signAccessToken(u) };
}
const input = (extra = {}) => ({
  title: `Суп ${T}`, category: CAT, main: ["Первое"], tags: ["быстро"], time: "30 мин", servings: "2",
  ingredients: [{ name: "Вода", amount: "1 л" }], steps: [{ text: "Варить 15 мин" }], ...extra,
});
// прошлые отправки «стареют» на сутки, чтобы суточный лимит не мешал
const submit = async (u, extra) => {
  await prisma.recipe.updateMany({ where: { authorId: u.id, submittedAt: { not: null } }, data: { submittedAt: new Date(Date.now() - 48 * 3600000) } });
  const r = await as(u, "post", "/me/submissions").send(input(extra));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const saveEdits = (id, extra = {}) => as(U.admin, "put", `/admin/submissions/${id}`).send(input(extra));
const reject = (id, reason = "тест") => as(U.admin, "post", `/admin/submissions/${id}/reject`).send({ reason });

before(async () => {
  await prisma.category.create({ data: { name: CAT, slug: `test-${T}` } });
  await mkUser("alice");
  await mkUser("bob");
  await mkUser("admin", "ADMIN");
});
beforeEach(() => limiters.resetAll());
after(async () => {
  const ids = Object.values(U).map((u) => u.id);
  await prisma.recipe.deleteMany({ where: { OR: [{ authorId: { in: ids } }, { slug: { contains: T } }] } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.category.deleteMany({ where: { slug: `test-${T}` } });
  await prisma.$disconnect();
});

test("сохранить правки без публикации: права, PENDING остаётся, adminEditedAt, видно автору и в очереди", async () => {
  const s = await submit(U.alice, { title: `Правки ${T}` });
  assert.equal(s.adminEditedAt, null);
  assert.equal((await api("put", `/admin/submissions/${s.id}`).send(input())).status, 401);
  assert.equal((await as(U.alice, "put", `/admin/submissions/${s.id}`).send(input())).status, 403);
  assert.equal((await saveEdits("00000000-0000-4000-8000-000000000000")).status, 404);
  assert.equal((await saveEdits("не-uuid")).status, 404);
  assert.equal((await as(U.admin, "put", `/admin/submissions/${s.id}`).send({ title: "x" })).status, 422);

  const r = await saveEdits(s.id, { title: `Правки админа ${T}`, status: "PUBLISHED", time: "45 мин" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "PENDING", "status из тела игнорируется");
  assert.equal(r.body.title, `Правки админа ${T}`);
  assert.ok(r.body.adminEditedAt);
  const row = await prisma.recipe.findUnique({ where: { id: s.id } });
  assert.equal(row.authorId, U.alice.id);
  assert.equal(row.reviewedAt, null, "решение не принято");
  assert.equal(row.submittedAt.getTime(), new Date(s.submittedAt).getTime(), "дата отправки не меняется");
  assert.equal((await api("get", `/recipes/${s.slug}`)).status, 404, "не опубликовано");

  const mine = (await as(U.alice, "get", `/me/submissions/${s.id}`)).body;
  assert.equal(mine.status, "PENDING");
  assert.ok(mine.adminEditedAt);
  assert.equal(mine.title, `Правки админа ${T}`);
  const q = (await as(U.admin, "get", "/admin/submissions?limit=50")).body.items.find((x) => x.id === s.id);
  assert.ok(q && q.adminEditedAt, "в очереди остаётся, с меткой");
  assert.equal((await saveEdits(s.id, { title: `Правки админа 2 ${T}` })).status, 200, "повторное сохранение допустимо");
});

test("после правок админа автор не может править (409 ADMIN_EDITING); отказ снимает блокировку; правка автора возвращает на модерацию", async () => {
  const s = await submit(U.bob, { title: `Блок ${T}` });
  assert.equal((await as(U.bob, "put", `/me/submissions/${s.id}`).send(input({ title: `Блок до ${T}` }))).status, 200, "до правок админа автор правит");
  assert.equal((await saveEdits(s.id, { title: `Блок админ ${T}` })).status, 200);
  const late = await as(U.bob, "put", `/me/submissions/${s.id}`).send(input({ title: `Блок после ${T}` }));
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "ADMIN_EDITING");
  assert.match(late.body.error.message, /Администратор вносит правки/);
  assert.equal((await prisma.recipe.findUnique({ where: { id: s.id } })).title, `Блок админ ${T}`, "правка админа не затёрта");

  assert.equal((await reject(s.id, "нужны доработки")).status, 200);
  const rej = (await as(U.bob, "get", `/me/submissions/${s.id}`)).body;
  assert.equal(rej.status, "REJECTED");
  assert.equal(rej.adminEditedAt, null, "блокировка снята");
  assert.equal((await saveEdits(s.id)).status, 409, "отклонённое правками админа не сохраняется");
  const fixed = await as(U.bob, "put", `/me/submissions/${s.id}`).send(input({ title: `Блок исправлен ${T}` }));
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.status, "PENDING");
  assert.equal(fixed.body.adminEditedAt, null);
});

test("правки админа неприменимы к уже рассмотренному и к обычному рецепту", async () => {
  const s = await submit(U.alice, { title: `Готово ${T}` });
  assert.equal((await as(U.admin, "post", `/admin/submissions/${s.id}/approve`)).status, 200);
  const r = await saveEdits(s.id);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "NOT_PENDING");
  const own = await as(U.admin, "post", "/recipes").send(input({ title: `Обычный ${T}`, status: "DRAFT" }));
  assert.equal(own.status, 201);
  assert.equal((await saveEdits(own.body.id)).status, 404, "не предложение");
});

test("slug: админ может поправить; занятый — 409 SLUG_TAKEN, метка не остаётся", async () => {
  const a = await submit(U.alice, { title: `Слаг А ${T}` });
  const b = await submit(U.bob, { title: `Слаг Б ${T}` });
  const ok = await saveEdits(a.id, { slug: `slug-edit-${T}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.slug, `slug-edit-${T}`);
  const clash = await saveEdits(b.id, { slug: `slug-edit-${T}` });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, "SLUG_TAKEN");
  assert.equal((await prisma.recipe.findUnique({ where: { id: b.id } })).adminEditedAt, null, "откат транзакции");
});

test("гонка: правка автора и сохранение правок админа одновременно — итог согласован, блокировка стоит", async () => {
  for (let i = 0; i < 6; i++) {
    const s = await submit(U.alice, { title: `Гонка-А ${i} ${T}` });
    const [p, a] = await Promise.all([
      as(U.alice, "put", `/me/submissions/${s.id}`).send(input({ title: `Гонка-А ${i} автор ${T}` })),
      saveEdits(s.id, { title: `Гонка-А ${i} админ ${T}` }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.ok([200, 409].includes(p.status), `put=${p.status}`);
    if (p.status === 409) assert.equal(p.body.error.code, "ADMIN_EDITING");
    const row = await prisma.recipe.findUnique({ where: { id: s.id } });
    assert.equal(row.status, "PENDING");
    assert.ok(row.adminEditedAt);
    // автор успел раньше — админ его перезаписал; не успел — 409. Смеси полей двух правок быть не может.
    assert.equal(row.title, `Гонка-А ${i} админ ${T}`);
    assert.equal(await prisma.ingredient.count({ where: { recipeId: s.id } }), 1);
    assert.equal(await prisma.step.count({ where: { recipeId: s.id } }), 1);
    await prisma.recipe.delete({ where: { id: s.id } });
  }
});

test("гонка: отказ и сохранение правок админа одновременно — итог согласован", async () => {
  for (let i = 0; i < 4; i++) {
    const s = await submit(U.bob, { title: `Гонка-О ${i} ${T}` });
    const [rj, ed] = await Promise.all([reject(s.id, "причина"), saveEdits(s.id, { title: `Гонка-О ${i} правка ${T}` })]);
    assert.equal(rj.status, 200);
    assert.ok([200, 409].includes(ed.status), `edit=${ed.status}`);
    const row = await prisma.recipe.findUnique({ where: { id: s.id } });
    assert.equal(row.status, "REJECTED");
    assert.equal(row.adminEditedAt, null, "после отказа автор не заблокирован");
    await prisma.recipe.delete({ where: { id: s.id } });
  }
});
