const { AppError } = require("../../lib/errors");
const storage = require("../../lib/storage");

// тип определяем по сигнатуре файла, а не по заявленному клиентом Content-Type
function detectImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

async function uploadImage(file, baseUrl) {
  if (!file) throw new AppError(422, "VALIDATION_ERROR", "Нужен файл в поле file");
  const ext = detectImage(file.buffer);
  if (!ext) throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Допустимы только jpeg, png и webp");
  return storage.save(file.buffer, ext, baseUrl);
}

module.exports = { uploadImage };
