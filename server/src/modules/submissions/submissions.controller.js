const service = require("./submissions.service");

exports.listMine = async (req, res) => res.json(await service.listMine(req.user.id));
exports.getMine = async (req, res) => res.json(await service.getMine(req.user.id, req.params.id));
exports.create = async (req, res) => res.status(201).json(await service.create(req.user.id, req.body));
exports.update = async (req, res) => res.json(await service.update(req.user.id, req.params.id, req.body));

exports.queue = async (req, res) => res.json(await service.queue(req.validQuery));
exports.approve = async (req, res) => res.json(await service.approve(req.params.id));
exports.reject = async (req, res) => res.json(await service.reject(req.params.id, req.body.reason));
