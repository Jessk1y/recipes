const service = require("./shopping.service");
const schemas = require("./shopping.schemas");
const { AppError } = require("../../lib/errors");

const notFound = () => new AppError(404, "NOT_FOUND", "Позиция не найдена");

// id в пути — uuid; чужая или несуществующая позиция даёт одинаковый 404
const idParam = (req, res, next) => {
  const parsed = schemas.itemId.safeParse(req.params);
  if (!parsed.success) return next(notFound());
  req.itemId = parsed.data.id;
  next();
};

exports.idParam = idParam;
exports.list = async (req, res) => res.json({ items: await service.list(req.user.id) });
exports.add = async (req, res) => {
  const added = await service.addEntries(req.user.id, req.body.items);
  res.json({ added, items: await service.list(req.user.id) });
};
exports.patch = async (req, res) => {
  if (!(await service.setChecked(req.user.id, req.itemId, req.body.checked))) throw notFound();
  res.json({ items: await service.list(req.user.id) });
};
exports.remove = async (req, res) => {
  if (!(await service.removeItem(req.user.id, req.itemId))) throw notFound();
  res.status(204).end();
};
exports.removeDish = async (req, res) => {
  await service.removeDish(req.user.id, req.params.slug);
  res.json({ items: await service.list(req.user.id) });
};
exports.clear = async (req, res) => {
  await service.clear(req.user.id);
  res.status(204).end();
};
