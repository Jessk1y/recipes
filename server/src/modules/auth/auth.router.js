const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const env = require("../../config/env");
const validate = require("../../middleware/validate");
const { requireAuth } = require("../../middleware/auth");
const schemas = require("./auth.schemas");
const c = require("./auth.controller");

const router = Router();

// ограничение частоты запросов к /auth (защита от перебора паролей)
router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.NODE_ENV === "test" ? 1000 : 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Слишком много запросов, попробуйте позже", details: null } },
  })
);

router.post("/register", validate(schemas.register), c.register);
router.post("/login", validate(schemas.login), c.login);
router.post("/refresh", validate(schemas.refresh), c.refresh);
router.post("/logout", requireAuth, validate(schemas.logout), c.logout);
router.get("/me", requireAuth, c.me);

module.exports = router;
