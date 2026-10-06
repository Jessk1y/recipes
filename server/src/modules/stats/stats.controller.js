const service = require("./stats.service");

exports.view = async (req, res) => {
  await service.recordView(req.body.slug);
  res.status(204).end(); // одинаково для любого корректного slug
};
exports.overview = async (req, res) => res.json(await service.overview(req.validQuery));
