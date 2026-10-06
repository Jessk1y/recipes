const service = require("./auth.service");
const emailAuth = require("./emailAuth.service");

exports.register = async (req, res) => res.status(201).json(await service.register(req.body));
exports.login = async (req, res) => res.json(await service.login(req.body));
exports.refresh = async (req, res) => res.json(await service.refresh(req.body));
exports.logout = async (req, res) => {
  await service.logout(req.user.id, req.body);
  res.status(204).end();
};
exports.me = async (req, res) => res.json(await service.me(req.user.id));

exports.verifyEmail = async (req, res) => res.json(await emailAuth.verifyEmail(req.body));
exports.resendVerification = async (req, res) => {
  await emailAuth.resendVerification(req.user.id);
  res.status(202).json({ ok: true });
};
// всегда 202 с одним и тем же телом — не раскрываем, есть ли такой e-mail
exports.forgotPassword = async (req, res) => {
  await emailAuth.forgotPassword(req.body);
  res.status(202).json({ ok: true });
};
exports.resetPassword = async (req, res) => {
  await emailAuth.resetPassword(req.body);
  res.json({ ok: true });
};
