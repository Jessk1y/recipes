const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../config/env");

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function signAccessToken(user) {
  return jwt.sign({ role: user.role }, env.JWT_SECRET, {
    subject: user.id,
    expiresIn: ACCESS_TTL_SECONDS,
    algorithm: "HS256",
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] });
}

// refresh-токен — случайная строка; в БД хранится только её SHA-256
function newRefreshToken() {
  return crypto.randomBytes(48).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = { signAccessToken, verifyAccessToken, newRefreshToken, hashToken, REFRESH_TTL_MS };
