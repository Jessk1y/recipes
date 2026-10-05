const service = require("./admin.service");

exports.listUsers = async (req, res) => res.json(await service.listUsers(req.validQuery));
exports.setRole = async (req, res) => res.json(await service.setRole(req.params.id, req.body.role));
exports.setBlocked = async (req, res) => res.json(await service.setBlocked(req.params.id, req.body.blocked));
