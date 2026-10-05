const { Router } = require("express");
const validate = require("../../middleware/validate");
const { requireAuth, requireActiveAdmin } = require("../../middleware/auth");
const schemas = require("./admin.schemas");
const c = require("./admin.controller");

const router = Router();
router.use(requireAuth, requireActiveAdmin); // всё под /admin — только для действующего администратора

router.get("/users", validate.query(schemas.listQuery), c.listUsers);
router.patch("/users/:id/role", validate.params(schemas.userId), validate(schemas.setRole), c.setRole);
router.patch("/users/:id/block", validate.params(schemas.userId), validate(schemas.setBlocked), c.setBlocked);

module.exports = router;
