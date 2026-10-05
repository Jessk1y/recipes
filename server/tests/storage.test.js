// Драйвер Cloudinary проверяется на подменённом SDK — настоящих запросов в облако нет.
process.env.STORAGE_DRIVER = "cloudinary";
process.env.CLOUDINARY_URL = "cloudinary://key:secret@democloud";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { v2: cloudinary } = require("cloudinary");
const storage = require("../src/lib/storage");

const ID = "0b8f2f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

test("save: грузит в папку recipes с uuid и возвращает https-URL и размеры", async () => {
  let opts, bytes;
  cloudinary.uploader.upload_stream = (o, cb) => {
    opts = o;
    return {
      end(buf) {
        bytes = buf;
        cb(null, { secure_url: `https://res.cloudinary.com/democloud/image/upload/v1/${o.folder}/${o.public_id}.jpg`, public_id: `${o.folder}/${o.public_id}`, width: 800, height: 600 });
      },
    };
  };
  const r = await storage.save(Buffer.from("img"), "jpg", "http://ignored");
  assert.equal(opts.folder, "recipes");
  assert.match(opts.public_id, /^[0-9a-f-]{36}$/);
  assert.equal(bytes.toString(), "img");
  assert.match(r.url, /^https:\/\/res\.cloudinary\.com\/democloud\/image\/upload\/v1\/recipes\/[0-9a-f-]{36}\.jpg$/);
  assert.equal(r.publicId, `recipes/${opts.public_id}`);
  assert.deepEqual([r.width, r.height], [800, 600]);
});

test("remove: удаляет только свои файлы (наш cloud, папка recipes, uuid)", async () => {
  const destroyed = [];
  cloudinary.uploader.destroy = async (id) => destroyed.push(id);
  const base = "https://res.cloudinary.com/democloud/image/upload";
  await storage.remove(`${base}/v1700000000/recipes/${ID}.jpg`);
  await storage.remove(`${base}/recipes/${ID}.webp`);
  assert.deepEqual(destroyed, [`recipes/${ID}`, `recipes/${ID}`]);

  destroyed.length = 0;
  await storage.remove(`https://res.cloudinary.com/othercloud/image/upload/recipes/${ID}.jpg`); // чужой cloud
  await storage.remove(`${base}/other/${ID}.jpg`); // не наша папка
  await storage.remove(`${base}/recipes/not-a-uuid.jpg`);
  await storage.remove("images/borscht.jpg");
  await storage.remove("https://images.pexels.com/photos/1/pexels-photo-1.jpeg");
  await storage.remove(null);
  assert.deepEqual(destroyed, []);
});
