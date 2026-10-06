// Канонический вид e-mail для проверки уникальности: у Gmail точки в имени и «+метка» ничего не меняют
// (a.b+shop@gmail.com, ab@gmail.com и a.b@googlemail.com — один ящик), поэтому ключ у них одинаковый.
// У остальных почтовых сервисов точки значимы, ключ = сам адрес. Сам адрес пользователя хранится как введён.
const GMAIL = new Set(["gmail.com", "googlemail.com"]);

function emailKey(email) {
  const at = email.lastIndexOf("@");
  if (at < 1) return email;
  const domain = email.slice(at + 1);
  if (!GMAIL.has(domain)) return email;
  const local = email.slice(0, at).split("+")[0].replace(/\./g, "");
  return local ? `${local}@gmail.com` : email;
}

module.exports = { emailKey };
