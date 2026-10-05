const service = require("./sync.service");

exports.sync = async (req, res) => res.json(await service.sync(req.user.id, req.body.ops));
