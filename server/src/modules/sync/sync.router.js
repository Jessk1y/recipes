const { Router } = require("express");
const validate = require("../../middleware/validate");
const { requireAuth } = require("../../middleware/auth");
const schemas = require("./sync.schemas");
const c = require("./sync.controller");

const router = Router();
router.use(requireAuth);
router.post("/", validate(schemas.sync), c.sync);

module.exports = router;
