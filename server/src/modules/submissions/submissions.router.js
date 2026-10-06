// /me/submissions — предложения рецептов текущего пользователя. Просмотр — любому вошедшему,
// отправка и правка — только с подтверждённым e-mail (guard читает БД, не JWT).
const { Router } = require("express");
const validate = require("../../middleware/validate");
const { requireAuth, requireVerifiedEmail } = require("../../middleware/auth");
const schemas = require("./submissions.schemas");
const c = require("./submissions.controller");

const router = Router();
router.use(requireAuth);

router.get("/", c.listMine);
router.get("/:id", c.getMine);
router.post("/", requireVerifiedEmail, validate(schemas.submissionInput), c.create);
router.put("/:id", requireVerifiedEmail, validate(schemas.submissionInput), c.update);

module.exports = router;
