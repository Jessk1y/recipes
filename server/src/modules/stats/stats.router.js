const { Router } = require("express");
const validate = require("../../middleware/validate");
const limiters = require("../../middleware/rateLimits");
const schemas = require("./stats.schemas");
const c = require("./stats.controller");

// Публичный «лёгкий» запрос фронтенда при открытии рецепта. Раз в сутки с устройства — на стороне
// клиента (устройства сервер не знает, личных данных не хранит); сервер защищается лимитом по IP.
const router = Router();
router.post("/view", limiters.view, validate(schemas.viewInput), c.view);

module.exports = router;
