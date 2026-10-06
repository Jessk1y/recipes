// Предложения рецептов: права, изоляция авторов, модерация, лимит в сутки, фото, очистка отклонённых.
process.env.NODE_ENV = "test";
process.env.STORAGE_DRIVER = "local";
const fs = require("node:fs");
const path = require("node:path");
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../src/app");
const env = require("../src/config/env");
const prisma = require("../src/lib/prisma");
const storage = require("../src/lib/storage");
const limiters = require("../src/middleware/rateLimits");
const { signAccessToken } = require("../src/lib/jwt");
const { cleanup, REJECTED_TTL_MS } = require("../src/lib/cleanup");

const T = `zs${Date.now().toString(36)}`;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex");
const api = (m, url) => request(app)[m](`/api/v1${url}`);
const as = (u, m, url) => api(m, url).set("Authorization", `Bearer ${u.token}`);
const CAT = `Тест ${T}`;
const U = {}; // имя → { id, token }

async function mkUser(name, { role = "USER", verified = true, blocked = false } = {}) {
  const u = await prisma.user.create({
    data: {
      email: `${name}-${T}@sub-test.example.com`, passwordHash: "x", displayName: name, role, isBlocked: blocked,
      emailVerifiedAt: verified ? new Date() : null,
    },
  });
  U[name] = { id: u.id, token: signAccessToken(u) };
}
const input = (extra = {}) => ({
  title: `Суп ${T}`, category: CAT, main: ["Первое"], tags: ["быстро"], time: "30 мин", servings: "2",
  ingredients: [{ name: "Вода", amount: "1 л" }], steps: [{ text: "Варить 15 мин" }], ...extra,
});
// free: прошлые отправки пользователя «стареют» на сутки, чтобы общий лимит не мешал остальным тестам
const submit = async (u, extra, free = true) => {
  if (free) await prisma.recipe.updateMany({ where: { authorId: u.id, submittedAt: { not: null } }, data: { submittedAt: new Date(Date.now() - 48 * 3600000) } });
  const r = await as(u, "post", "/me/submissions").send(input(extra));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const upload = (u) => as(u, "post", "/uploads/image").attach("file", PNG, "a.png");
const reject = (id, reason = "тест") => as(U.admin, "post", `/admin/submissions/${id}/reject`).send({ reason });
const fileOf = (url) => path.join(storage.UPLOAD_DIR, url.split("/uploads/")[1]);

before(async () => {
  await prisma.category.create({ data: { name: CAT, slug: `test-${T}` } });
  await mkUser("alice");
  await mkUser("bob");
  await mkUser("carol", { verified: false });
  await mkUser("dave", { blocked: true });
  await mkUser("admin", { role: "ADMIN" });
});
beforeEach(() => limiters.resetAll());
after(async () => {
  const ids = Object.values(U).map((u) => u.id);
  const imgs = (await prisma.recipe.findMany({ where: { authorId: { in: ids } }, select: { image: true } })).map((r) => r.image);
  await prisma.recipe.deleteMany({ where: { OR: [{ authorId: { in: ids } }, { slug: { contains: T } }] } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.category.deleteMany({ where: { slug: `test-${T}` } });
  for (const i of imgs) await storage.remove(i);
  await prisma.$disconnect();
});

// ---------- доступ ----------

test("гость: все эндпоинты предложений и модерации — 401", async () => {
  const id = "00000000-0000-4000-8000-000000000000";
  for (const [m, url] of [
    ["get", "/me/submissions"], ["post", "/me/submissions"], ["get", `/me/submissions/${id}`], ["put", `/me/submissions/${id}`],
    ["get", "/admin/submissions"], ["post", `/admin/submissions/${id}/approve`], ["post", `/admin/submissions/${id}/reject`],
    ["post", "/uploads/image"],
  ]) assert.equal((await api(m, url).send({})).status, 401, `${m} ${url}`);
});

test("e-mail не подтверждён → отправка и загрузка фото 403 EMAIL_NOT_VERIFIED; список смотреть можно", async () => {
  const r = await as(U.carol, "post", "/me/submissions").send(input());
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "EMAIL_NOT_VERIFIED");
  const up = await upload(U.carol);
  assert.equal(up.status, 403);
  assert.equal(up.body.error.code, "EMAIL_NOT_VERIFIED");
  assert.equal((await as(U.carol, "get", "/me/submissions")).status, 200);
  assert.equal(await prisma.recipe.count({ where: { authorId: U.carol.id } }), 0);
});

test("заблокированный: отправка и загрузка — 403 ACCOUNT_BLOCKED", async () => {
  assert.equal((await as(U.dave, "post", "/me/submissions").send(input())).body.error.code, "ACCOUNT_BLOCKED");
  assert.equal((await upload(U.dave)).body.error.code, "ACCOUNT_BLOCKED");
});

test("обычный пользователь не получает админских прав: /admin/*, запись рецептов и смена статуса — 403", async () => {
  const s = await submit(U.alice);
  for (const [m, url, body] of [
    ["get", "/admin/submissions"], ["post", `/admin/submissions/${s.id}/approve`],
    ["post", `/admin/submissions/${s.id}/reject`, { reason: "нет" }],
    ["put", `/recipes/${s.id}`, input({ status: "PUBLISHED" })], ["patch", `/recipes/${s.id}/status`, { status: "PUBLISHED" }],
    ["delete", `/recipes/${s.id}`], ["post", "/recipes", input()],
  ]) assert.equal((await as(U.alice, m, url).send(body)).status, 403, `${m} ${url}`);
  assert.equal((await prisma.recipe.findUnique({ where: { id: s.id } })).status, "PENDING");
});

// ---------- создание ----------

test("создание: PENDING, автор = я, slug/status из тела игнорируются, таймер из текста", async () => {
  const s = await submit(U.alice, { slug: "hack", status: "PUBLISHED", title: `Хитрый суп ${T}` });
  assert.equal(s.status, "PENDING");
  assert.notEqual(s.slug, "hack");
  assert.match(s.slug, /^hitryy-sup/);
  assert.equal(s.rejectReason, null);
  const row = await prisma.recipe.findUnique({ where: { id: s.id } });
  assert.equal(row.authorId, U.alice.id);
  assert.ok(row.submittedAt);
  assert.equal(s.steps[0].timerSeconds, 900);
});

test("валидация: несуществующая категория, >10 тегов, чужой URL фото, нет ингредиентов → 422", async () => {
  const bad = async (extra, field) => {
    const r = await as(U.alice, "post", "/me/submissions").send(input(extra));
    assert.equal(r.status, 422, field);
    assert.ok(r.body.error.details.some((d) => d.field.startsWith(field)), `${field}: ${JSON.stringify(r.body.error.details)}`);
  };
  await bad({ category: "Новая категория " + T }, "category");
  await bad({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, "tags");
  await bad({ image: "https://evil.example.com/pixel.png" }, "image");
  await bad({ image: "images/borsch.jpg" }, "image");
  await bad({ ingredients: [] }, "ingredients");
  assert.equal(await prisma.category.count({ where: { name: "Новая категория " + T } }), 0);
});

// ---------- видимость и изоляция ----------

test("PENDING/REJECTED не видны никому, кроме админа (список, :slug, snapshot, избранное)", async () => {
  const s = await submit(U.alice, { title: `Невидимка ${T}` });
  assert.equal((await api("get", `/recipes/${s.slug}`)).status, 404);
  assert.equal((await as(U.bob, "get", `/recipes/${s.slug}`)).status, 404);
  assert.equal((await as(U.alice, "get", `/recipes/${s.slug}`)).status, 404, "автор читает через /me/submissions");
  assert.equal((await as(U.admin, "get", `/recipes/${s.slug}`)).status, 200);
  const q = encodeURIComponent(`Невидимка ${T}`);
  assert.equal((await api("get", `/recipes?q=${q}`)).body.total, 0);
  assert.equal((await as(U.alice, "get", `/recipes?q=${q}&status=PENDING`)).status, 422);
  assert.equal((await as(U.alice, "get", `/recipes?q=${q}&status=all`)).status, 403);
  assert.equal((await as(U.admin, "get", `/recipes?q=${q}&status=all`)).body.total, 0, "all = DRAFT+PUBLISHED");
  assert.ok(!(await api("get", "/catalog/snapshot")).body.recipes.some((r) => r.id === s.id));
  assert.equal((await as(U.alice, "put", `/me/favorites/${s.slug}`)).status, 404);
  await reject(s.id);
  assert.equal((await api("get", `/recipes/${s.slug}`)).status, 404);
  assert.ok(!(await api("get", "/catalog/snapshot")).body.recipes.some((r) => r.id === s.id));
});

test("изоляция авторов: чужое предложение — 404 на чтение и правку, в моём списке только мои", async () => {
  const a = await submit(U.alice, { title: `Алисин ${T}` });
  const b = await submit(U.bob, { title: `Бобов ${T}` });
  assert.equal((await as(U.bob, "get", `/me/submissions/${a.id}`)).status, 404);
  assert.equal((await as(U.bob, "put", `/me/submissions/${a.id}`).send(input({ title: "Взлом" }))).status, 404);
  assert.equal((await as(U.alice, "get", `/me/submissions/${b.id}`)).status, 404);
  assert.equal((await as(U.alice, "get", "/me/submissions/not-a-uuid")).status, 404);
  assert.equal((await prisma.recipe.findUnique({ where: { id: a.id } })).title, `Алисин ${T}`);
  const la = (await as(U.alice, "get", "/me/submissions")).body.items.map((r) => r.id);
  assert.ok(la.includes(a.id) && !la.includes(b.id));
  const lb = (await as(U.bob, "get", "/me/submissions")).body.items.map((r) => r.id);
  assert.ok(lb.includes(b.id) && !lb.includes(a.id));
  // рецепт без submittedAt (не предложение) недоступен через /me/submissions даже автору
  const cat = await prisma.category.findUnique({ where: { slug: `test-${T}` } });
  const own = await prisma.recipe.create({ data: { slug: `own-${T}`, title: "Не предложение", categoryId: cat.id, authorId: U.alice.id, status: "PENDING" } });
  assert.equal((await as(U.alice, "get", `/me/submissions/${own.id}`)).status, 404);
  assert.equal((await as(U.alice, "put", `/me/submissions/${own.id}`).send(input())).status, 404);
});

// ---------- модерация ----------

test("полный цикл: отказ с причиной → автор видит → правка → PENDING → одобрение → публичен → править нельзя", async () => {
  const s = await submit(U.alice, { title: `Цикл ${T}` });
  const q = await as(U.admin, "get", "/admin/submissions?limit=50");
  assert.equal(q.status, 200);
  assert.equal(q.body.items.find((r) => r.id === s.id).author.id, U.alice.id);
  assert.ok(q.body.items.every((r) => r.status === "PENDING"));

  assert.equal((await as(U.admin, "post", `/admin/submissions/${s.id}/reject`).send({})).status, 422);
  assert.equal((await reject(s.id, "  ")).status, 422);
  const rej = await reject(s.id, "Нет фото блюда");
  assert.equal(rej.status, 200);
  assert.equal(rej.body.status, "REJECTED");
  const mine = (await as(U.alice, "get", `/me/submissions/${s.id}`)).body;
  assert.equal(mine.status, "REJECTED");
  assert.equal(mine.rejectReason, "Нет фото блюда");
  assert.equal((await as(U.admin, "post", `/admin/submissions/${s.id}/approve`)).body.error.code, "NOT_PENDING");
  assert.equal((await reject(s.id, "ещё раз")).status, 409);

  const fixed = await as(U.alice, "put", `/me/submissions/${s.id}`).send(input({ title: `Цикл исправлен ${T}` }));
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.status, "PENDING");
  assert.equal(fixed.body.rejectReason, null);
  assert.equal(fixed.body.title, `Цикл исправлен ${T}`);
  assert.equal(fixed.body.slug, s.slug, "slug не меняется");

  const ok = await as(U.admin, "post", `/admin/submissions/${s.id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "PUBLISHED");
  assert.equal((await api("get", `/recipes/${s.slug}`)).status, 200);
  assert.ok((await api("get", "/catalog/snapshot")).body.recipes.some((r) => r.id === s.id));
  assert.equal((await as(U.alice, "get", `/me/submissions/${s.id}`)).body.status, "PUBLISHED");
  const late = await as(U.alice, "put", `/me/submissions/${s.id}`).send(input());
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "NOT_EDITABLE");
  assert.equal((await as(U.admin, "get", "/admin/submissions?limit=50")).body.items.some((r) => r.id === s.id), false);
});

test("админ правит и публикует через PUT /recipes/:id; PATCH status предложения запрещён (USE_MODERATION)", async () => {
  const s = await submit(U.bob, { title: `Правка админа ${T}` });
  const patch = await as(U.admin, "patch", `/recipes/${s.id}/status`).send({ status: "PUBLISHED" });
  assert.equal(patch.status, 409);
  assert.equal(patch.body.error.code, "USE_MODERATION");
  const put = await as(U.admin, "put", `/recipes/${s.id}`).send(input({ title: `Правка админа ${T}!`, status: "PUBLISHED" }));
  assert.equal(put.status, 200);
  assert.equal(put.body.status, "PUBLISHED");
  const row = await prisma.recipe.findUnique({ where: { id: s.id } });
  assert.equal(row.authorId, U.bob.id);
  assert.ok(row.reviewedAt);
  assert.equal((await as(U.bob, "get", `/me/submissions/${s.id}`)).body.title, `Правка админа ${T}!`);
  assert.equal((await as(U.bob, "put", `/me/submissions/${s.id}`).send(input())).status, 409);
});

test("гонка: одобрение и правка автора одновременно — итог согласован, ничего не теряется", async () => {
  for (let i = 0; i < 4; i++) {
    const s = await submit(U.alice, { title: `Гонка ${i} ${T}` });
    const [p, a] = await Promise.all([
      as(U.alice, "put", `/me/submissions/${s.id}`).send(input({ title: `Гонка ${i} правка ${T}` })),
      as(U.admin, "post", `/admin/submissions/${s.id}/approve`),
    ]);
    assert.equal(a.status, 200);
    assert.ok([200, 409].includes(p.status), `put=${p.status}`);
    const row = await prisma.recipe.findUnique({ where: { id: s.id } });
    assert.equal(row.status, "PUBLISHED");
    // правка либо целиком применена до публикации, либо целиком отклонена
    assert.equal(row.title, p.status === 200 ? `Гонка ${i} правка ${T}` : `Гонка ${i} ${T}`);
    await prisma.recipe.delete({ where: { id: s.id } });
  }
});

test("одобрение поднимает рецепт в начало ленты (createdAt = момент публикации)", async () => {
  const s = await submit(U.alice, { title: `Свежак ${T}` });
  await prisma.recipe.update({ where: { id: s.id }, data: { createdAt: new Date(Date.now() - 5 * 86400000) } });
  const t0 = Date.now();
  await as(U.admin, "post", `/admin/submissions/${s.id}/approve`);
  assert.ok((await prisma.recipe.findUnique({ where: { id: s.id } })).createdAt.getTime() >= t0 - 1000);
  assert.equal((await api("get", "/catalog/snapshot")).body.recipes[0].id, s.id);
});

// ---------- лимит ----------

test("лимит в сутки: свой у каждого, правка ожидающего его не тратит, отказ → правка считается новой отправкой", async () => {
  await mkUser("limited");
  const L = U.limited;
  const ids = [];
  for (let i = 0; i < env.SUBMISSIONS_PER_DAY; i++) ids.push((await submit(L, { title: `Лим ${i} ${T}` }, false)).id);
  const over = await as(L, "post", "/me/submissions").send(input());
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, "SUBMISSION_LIMIT");
  assert.ok(over.body.error.details.retryAt);
  assert.equal((await as(L, "put", `/me/submissions/${ids[0]}`).send(input({ title: "Правка" }))).status, 200);
  await submit(U.bob, { title: `Бобу можно ${T}` });
  // отказ → правка внутри окна: эта отправка уже учтена, разрешено
  await reject(ids[1]);
  assert.equal((await as(L, "put", `/me/submissions/${ids[1]}`).send(input())).status, 200);
  // старая отправка (>24 ч) вышла из окна → можно отправить новую
  await prisma.recipe.update({ where: { id: ids[2] }, data: { submittedAt: new Date(Date.now() - 25 * 3600000) } });
  assert.equal((await as(L, "post", "/me/submissions").send(input({ title: `После окна ${T}` }))).status, 201);
  // а вот отклонённая старая, возвращаясь на модерацию, снова упирается в лимит
  await reject(ids[2]);
  const again = await as(L, "put", `/me/submissions/${ids[2]}`).send(input());
  assert.equal(again.status, 429);
  assert.equal((await prisma.recipe.findUnique({ where: { id: ids[2] } })).status, "REJECTED");
});

test("лимит устойчив к гонке: параллельные отправки не превышают его", async () => {
  await mkUser("racer");
  const rs = await Promise.all(Array.from({ length: env.SUBMISSIONS_PER_DAY + 3 }, (_, i) =>
    as(U.racer, "post", "/me/submissions").send(input({ title: `Рейс ${i} ${T}` }))));
  assert.equal(rs.filter((r) => r.status === 201).length, env.SUBMISSIONS_PER_DAY);
  assert.equal(rs.filter((r) => r.status === 429).length, 3);
  assert.equal(await prisma.recipe.count({ where: { authorId: U.racer.id } }), env.SUBMISSIONS_PER_DAY);
});

// ---------- фото ----------

test("фото: те же проверки (415/422/413); своё фото принимается; замена удаляет старое; лимит загрузок", async () => {
  assert.equal((await as(U.alice, "post", "/uploads/image").attach("file", Buffer.from("not an image at all"), "a.png")).status, 415);
  assert.equal((await as(U.alice, "post", "/uploads/image")).status, 422);
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  assert.equal((await as(U.alice, "post", "/uploads/image").attach("file", big, "big.png")).status, 413);
  const up = await upload(U.alice);
  assert.equal(up.status, 201);
  assert.ok(storage.isOwn(up.body.url));
  const s = await submit(U.alice, { title: `С фото ${T}`, image: up.body.url });
  assert.equal(s.image, up.body.url);
  const up2 = await upload(U.alice);
  const e = await as(U.alice, "put", `/me/submissions/${s.id}`).send(input({ title: `С фото ${T}`, image: up2.body.url }));
  assert.equal(e.body.image, up2.body.url);
  assert.ok(!fs.existsSync(fileOf(up.body.url)), "старое фото удалено");
  assert.ok(fs.existsSync(fileOf(up2.body.url)));

  const keep = limiters.limits.upload.limit;
  limiters.limits.upload.limit = 2;
  limiters.resetAll();
  try {
    assert.equal((await upload(U.bob)).status, 201);
    assert.equal((await upload(U.bob)).status, 201);
    assert.equal((await upload(U.bob)).status, 429);
    assert.equal((await upload(U.alice)).status, 201, "счётчик у каждого пользователя свой");
    for (let i = 0; i < 3; i++) assert.equal((await upload(U.admin)).status, 201, "админ без лимита");
  } finally {
    limiters.limits.upload.limit = keep;
  }
});

// ---------- очистка ----------

test("cleanup: отклонённые без правок 30 дней удаляются вместе с фото; свежие, ожидающие и правленные остаются", async () => {
  await mkUser("cleaner");
  const C = U.cleaner;
  const up = await upload(C);
  const old = await submit(C, { title: `Старый отказ ${T}`, image: up.body.url });
  const fresh = await submit(C, { title: `Свежий отказ ${T}` });
  const pend = await submit(C, { title: `Ожидает ${T}` });
  await reject(old.id);
  await reject(fresh.id);
  const past = (days) => new Date(Date.now() - days * 86400000);
  await prisma.recipe.update({ where: { id: old.id }, data: { updatedAt: past(31) } });
  await prisma.recipe.update({ where: { id: fresh.id }, data: { updatedAt: past(29) } });
  await prisma.recipe.update({ where: { id: pend.id }, data: { updatedAt: past(90) } });
  assert.equal(REJECTED_TTL_MS, 30 * 86400000);
  assert.ok(fs.existsSync(fileOf(up.body.url)), "файл есть до очистки");

  const r = await cleanup();
  assert.ok(r.rejected >= 1);
  assert.equal(await prisma.recipe.findUnique({ where: { id: old.id } }), null);
  assert.ok(!fs.existsSync(fileOf(up.body.url)), "фото удалено вместе с предложением");
  assert.ok(await prisma.recipe.findUnique({ where: { id: fresh.id } }));
  assert.ok(await prisma.recipe.findUnique({ where: { id: pend.id } }), "ожидающие не трогаем");

  // правка автора возвращает предложение на модерацию — очистка его не касается
  await prisma.recipe.update({ where: { id: fresh.id }, data: { updatedAt: past(40) } });
  await as(C, "put", `/me/submissions/${fresh.id}`).send(input({ title: `Свежий отказ ${T} (исправлен)` }));
  await cleanup();
  assert.equal((await prisma.recipe.findUnique({ where: { id: fresh.id } })).status, "PENDING");
});

test("cleanup: фото, на которое ссылается другой рецепт, не удаляется", async () => {
  await mkUser("sharer");
  const up = await upload(U.sharer);
  const a = await submit(U.sharer, { title: `Общее фото ${T}`, image: up.body.url });
  await reject(a.id);
  const cat = await prisma.category.findUnique({ where: { slug: `test-${T}` } });
  await prisma.recipe.create({ data: { slug: `shared-${T}`, title: "Другой", categoryId: cat.id, image: up.body.url, status: "PUBLISHED", authorId: U.admin.id } });
  await prisma.recipe.update({ where: { id: a.id }, data: { updatedAt: new Date(Date.now() - 31 * 86400000) } });
  await cleanup();
  assert.equal(await prisma.recipe.findUnique({ where: { id: a.id } }), null);
  assert.ok(fs.existsSync(fileOf(up.body.url)));
});
