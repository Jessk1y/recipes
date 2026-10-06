// /admin/push — Web Push для администратора: ключ, подписка/отписка этого браузера, тестовое уведомление.
const { Router } = require("express");
const validate = require("../../middleware/validate");
const { requireAuth, requireActiveAdmin } = require("../../middleware/auth");
const schemas = require("./push.schemas");
const c = require("./push.controller");

const router = Router();
router.use(requireAuth, requireActiveAdmin);

router.get("/key", c.key);
router.put("/subscription", validate(schemas.subscription), c.subscribe);
router.delete("/subscription", validate(schemas.endpointOnly), c.unsubscribe);
router.post("/test", validate(schemas.endpointOnly), c.test);

module.exports = router;
