const { Router } = require("express");
const validate = require("../../middleware/validate");
const { requireAuth, requireActiveAdmin } = require("../../middleware/auth");
const schemas = require("./admin.schemas");
const c = require("./admin.controller");
const subSchemas = require("../submissions/submissions.schemas");
const sub = require("../submissions/submissions.controller");

const router = Router();
router.use(requireAuth, requireActiveAdmin); // всё под /admin — только для действующего администратора

router.get("/users", validate.query(schemas.listQuery), c.listUsers);
router.patch("/users/:id/role", validate.params(schemas.userId), validate(schemas.setRole), c.setRole);
router.patch("/users/:id/block", validate.params(schemas.userId), validate(schemas.setBlocked), c.setBlocked);

// модерация предложений рецептов («поправить и опубликовать» — обычный PUT /recipes/:id со status=PUBLISHED)
router.get("/submissions", validate.query(subSchemas.queueQuery), sub.queue);
router.post("/submissions/:id/approve", sub.approve);
router.post("/submissions/:id/reject", validate(subSchemas.rejectInput), sub.reject);

module.exports = router;
