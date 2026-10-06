// Статистика. Просмотры: на (рецепт, день UTC) хранится только счётчик — без IP, пользователя и устройства.
// Избранное и корзина считаются «вживую» из личных данных, но наружу уходят лишь агрегаты по рецептам.
const prisma = require("../../lib/prisma");
const { findPublished } = require("../../lib/recipeRef");

const DAY = 24 * 60 * 60 * 1000;

// Засчитывает просмотр опубликованного рецепта. Неизвестный и неопубликованный slug молча игнорируется
// (ответ одинаковый — по нему нельзя выяснить, есть ли такой черновик).
async function recordView(slug) {
  const r = await findPublished(slug);
  if (!r) return false;
  await prisma.$executeRaw`
    INSERT INTO recipe_views (recipe_id, day, count)
    VALUES (${r.id}::uuid, (now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (recipe_id, day) DO UPDATE SET count = recipe_views.count + 1`;
  return true;
}

// понедельник (UTC) недели, в которую попадает момент t
function weekStart(t) {
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}
const iso = (d) => d.toISOString().slice(0, 10);

// последние `weeks` недель (последняя — текущая, неполная), пропуски заполнены нулями
function weekKeys(weeks, now = new Date()) {
  const last = weekStart(now).getTime();
  return Array.from({ length: weeks }, (_, i) => iso(new Date(last - (weeks - 1 - i) * 7 * DAY)));
}

// строки { week: 'YYYY-MM-DD', n } → массив по неделям
function fill(keys, rows) {
  const by = new Map(rows.map((r) => [r.week, Number(r.n)]));
  return keys.map((k) => by.get(k) ?? 0);
}

async function overview({ weeks }) {
  const now = new Date();
  const keys = weekKeys(weeks, now);
  const since = keys[0]; // начало первой недели (дата)
  const day7 = iso(new Date(now.getTime() - 6 * DAY)); // последние 7 суток включая сегодня (UTC)

  const [viewRows, userRows, subRows, perRecipe, favRows, cartRows, totals] = await Promise.all([
    prisma.$queryRaw`SELECT to_char(date_trunc('week', day), 'YYYY-MM-DD') AS week, SUM(count)::int AS n
      FROM recipe_views WHERE day >= ${since}::date GROUP BY 1`,
    prisma.$queryRaw`SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week, COUNT(*)::int AS n
      FROM users WHERE created_at >= ${since}::date GROUP BY 1`,
    prisma.$queryRaw`SELECT to_char(date_trunc('week', submitted_at), 'YYYY-MM-DD') AS week, COUNT(*)::int AS n
      FROM recipes WHERE submitted_at IS NOT NULL AND submitted_at >= ${since}::date GROUP BY 1`,
    prisma.$queryRaw`SELECT recipe_id::text AS id, SUM(count)::int AS total,
        COALESCE(SUM(count) FILTER (WHERE day >= ${day7}::date), 0)::int AS last7
      FROM recipe_views GROUP BY recipe_id`,
    prisma.$queryRaw`SELECT recipe_id::text AS id, COUNT(*)::int AS n FROM favorites GROUP BY recipe_id`,
    // «в корзине» — у скольких пользователей блюдо сейчас лежит в корзине
    prisma.$queryRaw`SELECT c.recipe_id::text AS id, COUNT(DISTINCT i.user_id)::int AS n
      FROM shopping_contribs c JOIN shopping_items i ON i.id = c.item_id
      WHERE c.recipe_id IS NOT NULL GROUP BY c.recipe_id`,
    Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: new Date(now.getTime() - 7 * DAY) } } }),
      prisma.recipe.count({ where: { status: "PUBLISHED" } }),
      prisma.recipe.count({ where: { submittedAt: { not: null } } }),
      prisma.recipe.count({ where: { status: "PENDING", submittedAt: { not: null } } }),
    ]),
  ]);

  const recipes = await prisma.recipe.findMany({
    where: { status: "PUBLISHED" },
    select: { id: true, slug: true, title: true },
  });
  const m = (rows, f) => new Map(rows.map((r) => [r.id, f(r)]));
  const views = m(perRecipe, (r) => r);
  const favs = m(favRows, (r) => r.n);
  const carts = m(cartRows, (r) => r.n);
  const list = recipes
    .map((r) => ({
      slug: r.slug,
      title: r.title,
      views: views.get(r.id)?.total ?? 0,
      views7d: views.get(r.id)?.last7 ?? 0,
      favorites: favs.get(r.id) ?? 0,
      cart: carts.get(r.id) ?? 0,
    }))
    .sort((a, b) => b.views - a.views || b.favorites - a.favorites || a.title.localeCompare(b.title, "ru"));

  const [users, newUsers7d, published, submissions, pending] = totals;
  const [wViews, wUsers, wSubs] = [viewRows, userRows, subRows].map((rows) => fill(keys, rows));
  const sum = (k) => list.reduce((s, r) => s + r[k], 0);
  return {
    generatedAt: now.toISOString(),
    summary: {
      views: sum("views"),
      views7d: sum("views7d"),
      favorites: sum("favorites"),
      cart: sum("cart"),
      users,
      newUsers7d,
      publishedRecipes: published,
      submissions,
      pendingSubmissions: pending,
    },
    weeks: keys.map((week, i) => ({ week, views: wViews[i], newUsers: wUsers[i], submissions: wSubs[i] })),
    recipes: list,
  };
}

module.exports = { recordView, overview, weekKeys, weekStart };
