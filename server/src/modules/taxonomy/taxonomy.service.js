const prisma = require("../../lib/prisma");
const MAIN_TAGS = require("../../lib/mainTags");

// count — число опубликованных рецептов категории
async function categories() {
  const rows = await prisma.category.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { recipes: { where: { status: "PUBLISHED" } } } } },
  });
  return rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, count: c._count.recipes }));
}

async function tags({ mainOnly }) {
  const rows = await prisma.tag.findMany({ where: mainOnly ? { isMain: true } : {}, orderBy: { name: "asc" } });
  rows.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.isMain ? MAIN_TAGS.indexOf(a.name) - MAIN_TAGS.indexOf(b.name) : 0;
  });
  return rows.map((t) => ({ id: t.id, name: t.name, isMain: t.isMain }));
}

module.exports = { categories, tags };
