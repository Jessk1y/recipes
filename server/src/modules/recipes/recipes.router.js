const { Router } = require("express");
const validate = require("../../middleware/validate");
const { requireAuth, optionalAuth, requireRole } = require("../../middleware/auth");
const schemas = require("./recipes.schemas");
const c = require("./recipes.controller");

const router = Router();
const admin = [requireAuth, requireRole("ADMIN")];

// чтение — для всех (админ дополнительно видит черновики)
router.get("/", optionalAuth, validate.query(schemas.listQuery), c.list);
router.get("/random", validate.query(schemas.randomQuery), c.random); // до /:slug
router.get("/:slug", optionalAuth, c.getBySlug);

// запись — только администратор
router.post("/", ...admin, validate(schemas.recipeInput), c.create);
router.put("/:id", ...admin, validate(schemas.recipeInput), c.update);
router.patch("/:id/status", ...admin, validate(schemas.statusInput), c.setStatus);
router.delete("/:id", ...admin, c.remove);

module.exports = router;
