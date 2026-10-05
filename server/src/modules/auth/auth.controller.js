const service = require("./auth.service");

exports.register = async (req, res) => res.status(201).json(await service.register(req.body));
exports.login = async (req, res) => res.json(await service.login(req.body));
exports.refresh = async (req, res) => res.json(await service.refresh(req.body));
exports.logout = async (req, res) => {
  await service.logout(req.user.id, req.body);
  res.status(204).end();
};
exports.me = async (req, res) => res.json(await service.me(req.user.id));
