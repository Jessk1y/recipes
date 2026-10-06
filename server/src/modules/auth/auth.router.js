const { Router } = require("express");
const limiters = require("../../middleware/rateLimits");
const validate = require("../../middleware/validate");
const { requireAuth } = require("../../middleware/auth");
const schemas = require("./auth.schemas");
const { requireCaptcha } = require("../../lib/turnstile");
const c = require("./auth.controller");

const router = Router();

// ограничение частоты запросов к /auth (защита от перебора паролей); письма — строже
router.use(limiters.auth);

router.post("/register", requireCaptcha, validate(schemas.register), c.register);
router.post("/login", validate(schemas.login), c.login);
router.post("/refresh", validate(schemas.refresh), c.refresh);
router.post("/logout", requireAuth, validate(schemas.logout), c.logout);
router.post("/verify-email", validate(schemas.tokenOnly), c.verifyEmail);
router.post("/resend-verification", limiters.mail, requireAuth, c.resendVerification);
router.post("/forgot-password", limiters.mail, validate(schemas.emailOnly), c.forgotPassword);
router.post("/reset-password", validate(schemas.resetPassword), c.resetPassword);
router.get("/me", requireAuth, c.me);

module.exports = router;
