// Генерация VAPID-ключей для Web Push и запись их в server/.env. Закрытый ключ в консоль НЕ печатается.
// Запуск: npm run push:keys. Если ключи в .env уже есть — ничего не делает: смена пары отключит все
// существующие подписки (их придётся оформить заново), поэтому для замены нужен флаг --force.
const fs = require("node:fs");
const path = require("node:path");
const webpush = require("web-push");

const ENV_FILE = path.join(__dirname, "..", ".env");
const force = process.argv.includes("--force");

let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
const has = (name) => new RegExp(`^${name}=\\s*\\S`, "m").test(text);

if ((has("VAPID_PRIVATE_KEY") || has("VAPID_PUBLIC_KEY")) && !force) {
  console.log("В server/.env уже есть VAPID-ключи — ничего не меняю. (Замена: npm run push:keys -- --force; все подписки слетят.)");
  process.exit(0);
}

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

function put(name, value) {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  if (re.test(text)) text = text.replace(re, () => line); // функция — чтобы «$» в значении не считался шаблоном
  else text += (text && !text.endsWith("\n") ? "\n" : "") + line + "\n";
}
put("VAPID_PUBLIC_KEY", publicKey);
put("VAPID_PRIVATE_KEY", privateKey);
fs.writeFileSync(ENV_FILE, text);

console.log("Ключи сгенерированы и записаны в server/.env:");
console.log(`  VAPID_PUBLIC_KEY   (${publicKey.length} символов)`);
console.log("  VAPID_PRIVATE_KEY  (скрыт, секрет)");
console.log("Те же две переменные нужно добавить в Render (Environment).");
