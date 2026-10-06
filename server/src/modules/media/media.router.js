const { Router } = require("express");
const multer = require("multer");
const { AppError } = require("../../lib/errors");
const { requireAuth, requireUploader } = require("../../middleware/auth");
const limiters = require("../../middleware/rateLimits");
const service = require("./media.service");

const MAX_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } }).single("file");

const router = Router();

// проверка прав и лимит — до multer, чтобы не принимать файл от неавторизованного
router.post("/image", requireAuth, requireUploader, limiters.upload, (req, res, next) => {
  upload(req, res, (err) => {
    if (err?.code === "LIMIT_FILE_SIZE") return next(new AppError(413, "FILE_TOO_LARGE", "Файл больше 5 МБ"));
    if (err) return next(new AppError(422, "VALIDATION_ERROR", "Некорректная загрузка файла"));
    next();
  });
}, async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.status(201).json(await service.uploadImage(req.file, baseUrl));
});

module.exports = router;
