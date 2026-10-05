const { Router } = require("express");
const validate = require("../../middleware/validate");
const { requireAuth } = require("../../middleware/auth");
const schemas = require("./shopping.schemas");
const c = require("./shopping.controller");

const router = Router();
router.use(requireAuth);

router.get("/", c.list);
router.delete("/", c.clear);
router.post("/items", validate(schemas.addItems), c.add);
router.patch("/items/:id", c.idParam, validate(schemas.patchItem), c.patch);
router.delete("/items/:id", c.idParam, c.remove);
router.delete("/dishes/:slug", c.removeDish);

module.exports = router;
