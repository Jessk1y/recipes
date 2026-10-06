const service = require("./push.service");

exports.key = (req, res) => res.json(service.key());
exports.subscribe = async (req, res) => {
  await service.subscribe(req.user.id, req.body);
  res.status(204).end();
};
exports.unsubscribe = async (req, res) => {
  await service.unsubscribe(req.user.id, req.body.endpoint);
  res.status(204).end();
};
exports.test = async (req, res) => {
  await service.sendTest(req.user.id, req.body.endpoint);
  res.json({ sent: true });
};
