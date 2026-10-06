const { Router } = require("express");
const env = require("../../config/env");
const service = require("./taxonomy.service");

const router = Router();

router.get("/categories", async (req, res) => res.json(await service.categories()));
router.get("/tags", async (req, res) =>
  res.json(await service.tags({ mainOnly: req.query.main === "true" }))
);

// публичные настройки для фронтенда: без почты он прячет «Забыли пароль?» и подсказки про подтверждение e-mail
router.get("/config", (req, res) => res.json({ mailEnabled: env.mailEnabled, submissionsPerDay: env.SUBMISSIONS_PER_DAY }));

module.exports = router;
