const service = require("./me.service");

exports.listFavorites = async (req, res) => res.json({ items: await service.listFavorites(req.user.id) });
exports.addFavorite = async (req, res) => {
  service.mustExist(await service.addFavorite(req.user.id, req.params.slug));
  res.status(204).end();
};
exports.removeFavorite = async (req, res) => {
  service.mustExist(await service.removeFavorite(req.user.id, req.params.slug));
  res.status(204).end();
};

exports.listNotes = async (req, res) => res.json({ items: await service.listNotes(req.user.id) });
exports.setNote = async (req, res) => {
  const at = new Date();
  const result = await service.setNote(req.user.id, req.params.slug, req.body.text, { at });
  if (result === "NOT_FOUND") throw service.recipeNotFound();
  if (result === "REMOVED") return res.status(204).end();
  res.json({ slug: req.params.slug, text: req.body.text, updatedAt: at });
};
exports.removeNote = async (req, res) => {
  const result = await service.removeNote(req.user.id, req.params.slug);
  if (result === "NOT_FOUND") throw service.recipeNotFound();
  res.status(204).end();
};
