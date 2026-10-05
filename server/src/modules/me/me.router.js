const { Router } = require("express");
const validate = require("../../middleware/validate");
const { requireAuth } = require("../../middleware/auth");
const schemas = require("./me.schemas");
const c = require("./me.controller");

const router = Router();
router.use(requireAuth); // всё под /me — только для вошедшего

router.get("/favorites", c.listFavorites);
router.put("/favorites/:slug", c.addFavorite);
router.delete("/favorites/:slug", c.removeFavorite);

router.get("/notes", c.listNotes);
router.put("/notes/:slug", validate(schemas.setNote), c.setNote);
router.delete("/notes/:slug", c.removeNote);

module.exports = router;
