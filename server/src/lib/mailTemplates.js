// Тексты писем. Ссылки ведут на фронтенд (hash-роутинг): токен читает страница и отправляет в API,
// поэтому «предпросмотр ссылок» в почтовиках токен не расходует (GET по ссылке ничего не меняет).
const env = require("../config/env");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const link = (route, token) => `${env.frontendUrl}/#/${route}?token=${encodeURIComponent(token)}`;

function layout(name, lead, url, button, footer) {
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#222">
<h2 style="margin:0 0 12px">🍳 Рецепты</h2>
<p>Здравствуйте, ${esc(name)}!</p>
<p>${esc(lead)}</p>
<p style="margin:24px 0"><a href="${esc(url)}" style="background:#d9623b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">${esc(button)}</a></p>
<p style="font-size:13px;color:#666">Если кнопка не работает, скопируйте ссылку в браузер:<br>${esc(url)}</p>
<p style="font-size:13px;color:#666">${esc(footer)}</p>
</div>`;
  const text = `Здравствуйте, ${name}!\n\n${lead}\n\n${url}\n\n${footer}`;
  return { html, text };
}

function verifyEmail(user, token) {
  const lead = "Подтвердите e-mail, чтобы завершить регистрацию. Ссылка действует 24 часа.";
  const footer = "Если вы не регистрировались на сайте рецептов, просто проигнорируйте это письмо.";
  return { subject: "Подтвердите e-mail", ...layout(user.displayName, lead, link("verify", token), "Подтвердить e-mail", footer) };
}

function resetPassword(user, token) {
  const lead = "Мы получили запрос на смену пароля. Ссылка действует 1 час и работает один раз.";
  const footer = "Если вы не запрашивали смену пароля — проигнорируйте письмо, пароль останется прежним.";
  return { subject: "Сброс пароля", ...layout(user.displayName, lead, link("reset", token), "Задать новый пароль", footer) };
}

module.exports = { verifyEmail, resetPassword };
