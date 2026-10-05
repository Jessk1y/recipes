// Хранилище загруженных изображений. СЕЙЧАС — заглушка: файлы на локальном диске (server/uploads).
// Перед деплоем (диск на Render временный) заменяется на Cloudinary с тем же интерфейсом:
//   save(buffer, ext) → { url, publicId }   remove(url)
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");

async function save(buffer, ext, baseUrl) {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const publicId = `${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, publicId), buffer);
  return { url: `${baseUrl}/uploads/${publicId}`, publicId };
}

// удаляет только файлы, загруженные через этот API (URL вида …/uploads/<uuid>.<ext>); иначе ничего не делает
async function remove(url) {
  const m = /\/uploads\/([0-9a-f-]{36}\.(?:jpg|png|webp))$/i.exec(url || "");
  if (!m) return;
  await fs.rm(path.join(UPLOAD_DIR, m[1]), { force: true });
}

module.exports = { save, remove, UPLOAD_DIR };
