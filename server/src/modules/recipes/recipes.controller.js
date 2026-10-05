const service = require("./recipes.service");

exports.list = async (req, res) => res.json(await service.list(req.validQuery, req.user));
exports.random = async (req, res) => res.json(await service.random(req.validQuery));
exports.getBySlug = async (req, res) => res.json(await service.getBySlug(req.params.slug, req.user));

exports.snapshot = async (req, res) => {
  // быстрый путь для офлайн-кэша: версия совпала → 304 без выборки рецептов
  res.set("ETag", `"${await service.snapshotVersion()}"`);
  res.set("Cache-Control", "no-cache");
  if (req.fresh) return res.status(304).end();
  res.json(await service.snapshot());
};

exports.create = async (req, res) => res.status(201).json(await service.create(req.body, req.user));
exports.update = async (req, res) => res.json(await service.update(req.params.id, req.body));
exports.setStatus = async (req, res) => res.json(await service.setStatus(req.params.id, req.body.status));
exports.remove = async (req, res) => {
  await service.remove(req.params.id);
  res.status(204).end();
};
