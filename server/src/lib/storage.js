// Хранилище загруженных изображений. Интерфейс одинаков у обоих драйверов:
//   save(buffer, ext, baseUrl) → { url, publicId, width, height }   remove(url)
// Драйвер: Cloudinary, если задан CLOUDINARY_URL (на Render — обязательно: диск там временный),
// иначе локальный диск server/uploads (разработка и тесты). Принудительно: STORAGE_DRIVER=local|cloudinary.
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
const CLOUD_FOLDER = "recipes";

const driverName = () =>
  process.env.STORAGE_DRIVER || (process.env.CLOUDINARY_URL ? "cloudinary" : "local");

// ---------- локальный диск ----------

const local = {
  async save(buffer, ext, baseUrl) {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const publicId = `${crypto.randomUUID()}.${ext}`;
    await fs.writeFile(path.join(UPLOAD_DIR, publicId), buffer);
    return { url: `${baseUrl}/uploads/${publicId}`, publicId, width: null, height: null };
  },

  // удаляет только файлы, загруженные через этот API (URL вида …/uploads/<uuid>.<ext>); иначе ничего не делает
  async remove(url) {
    const m = /\/uploads\/([0-9a-f-]{36}\.(?:jpg|png|webp))$/i.exec(url || "");
    if (!m) return;
    await fs.rm(path.join(UPLOAD_DIR, m[1]), { force: true });
  },
};

// ---------- Cloudinary ----------

let cloudinary;
function sdk() {
  if (!cloudinary) {
    cloudinary = require("cloudinary").v2; // читает CLOUDINARY_URL=cloudinary://<key>:<secret>@<cloud>
    cloudinary.config({ secure: true });
    if (!cloudinary.config().cloud_name) throw new Error("CLOUDINARY_URL не задан или некорректен");
  }
  return cloudinary;
}

const cloud = {
  async save(buffer) {
    const c = sdk();
    const res = await new Promise((resolve, reject) => {
      c.uploader
        .upload_stream(
          { folder: CLOUD_FOLDER, public_id: crypto.randomUUID(), resource_type: "image", overwrite: false },
          (err, r) => (err ? reject(err) : resolve(r))
        )
        .end(buffer);
    });
    return { url: res.secure_url, publicId: res.public_id, width: res.width, height: res.height };
  },

  // удаляет только наши файлы: https://res.cloudinary.com/<наш cloud>/image/upload/[v123/]recipes/<uuid>.<ext>
  async remove(url) {
    const c = sdk();
    const m = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/image\/upload\/(?:v\d+\/)?(recipes\/[0-9a-f-]{36})\.[a-z]+$/i.exec(url || "");
    if (!m || m[1] !== c.config().cloud_name) return;
    await c.uploader.destroy(m[2], { resource_type: "image", invalidate: true });
  },
};

const driver = () => (driverName() === "cloudinary" ? cloud : local);

module.exports = {
  driverName,
  save: (...args) => driver().save(...args),
  remove: (url) => driver().remove(url),
  UPLOAD_DIR,
};
