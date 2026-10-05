const { Router } = require("express");
const service = require("./taxonomy.service");

const router = Router();

router.get("/categories", async (req, res) => res.json(await service.categories()));
router.get("/tags", async (req, res) =>
  res.json(await service.tags({ mainOnly: req.query.main === "true" }))
);

module.exports = router;
