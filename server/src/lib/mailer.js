// Отправка писем. Драйвер выбирается в config/env.js:
//   brevo  — Brevo HTTP API (POST https://api.brevo.com/v3/smtp/email, заголовок api-key);
//   mailjet — Mailjet Send API v3.1 (POST https://api.mailjet.com/v3.1/send, Basic-авторизация ключ:секрет);
//   log    — только печать в лог (разработка без ключа; ссылку из письма видно в консоли сервера);
//   memory — копит письма в mailer.outbox (тесты).
// Тексты писем — в lib/mailTemplates.js.
const env = require("../config/env");
const logger = require("./logger");

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const MAILJET_URL = "https://api.mailjet.com/v3.1/send";
const TIMEOUT_MS = 10_000;

const outbox = []; // драйвер memory
const pending = new Set(); // письма, отправляемые «в фоне»

async function sendViaBrevo({ to, subject, html, text }) {
  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // тело ответа Brevo ({code, message}) полезно для диагностики и не содержит секретов
    const detail = await res.text().catch(() => "");
    throw new Error(`Brevo ${res.status}: ${detail.slice(0, 300)}`);
  }
}

async function sendViaMailjet({ to, subject, html, text }) {
  const auth = Buffer.from(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`).toString("base64");
  const res = await fetch(MAILJET_URL, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({
      Messages: [
        {
          From: { Email: env.MAIL_FROM_EMAIL, Name: env.MAIL_FROM_NAME },
          To: [{ Email: to }],
          Subject: subject,
          TextPart: text,
          HTMLPart: html,
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Mailjet ${res.status}: ${detail.slice(0, 300)}`);
  }
}

const drivers = {
  mailjet: sendViaMailjet,
  brevo: sendViaBrevo,
  async log({ to, subject, text }) {
    logger.info(`\n--- письмо для ${to}: ${subject} ---\n${text}\n---`);
  },
  async memory(mail) {
    outbox.push({ ...mail, at: Date.now() });
  },
};

// Отправить и дождаться результата (бросает ошибку при сбое)
function send(mail) {
  return drivers[env.mailDriver](mail);
}

// Отправить «в фоне»: ответ API не ждёт почтовый сервис (иначе по времени ответа
// видно, есть ли такой e-mail). Ошибка пишется в лог, наружу не выходит.
function sendInBackground(mail) {
  const p = send(mail)
    .catch((err) => logger.error({ err: err.message, to: mail.to, subject: mail.subject }, "не удалось отправить письмо"))
    .finally(() => pending.delete(p));
  pending.add(p);
  return p;
}

// Дождаться фоновых отправок (тесты, остановка сервера)
const idle = () => Promise.allSettled([...pending]);

module.exports = { send, sendInBackground, idle, outbox, drivers };
