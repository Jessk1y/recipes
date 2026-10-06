const { z } = require("zod");
const { isAscii } = require("../../lib/emailCheck");

const email = z.string().trim().toLowerCase().email("Некорректный e-mail").max(254);

// bcrypt учитывает только первые 72 байта
const password = z.string().min(8, "Пароль — не менее 8 символов").max(72, "Пароль — не более 72 символов");

const confirmPassword = z.string().max(72);
const mismatch = { message: "Пароли не совпадают", path: ["confirmPassword"] };
const token = z.string().min(20).max(200);

// только для регистрации: у уже существующих пользователей адреса могут быть любыми, вход/сброс их не режут
const registerEmail = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isAscii, { message: "E-mail — только латинские буквы, цифры и обычные символы (без кириллицы и пробелов)", abort: true })
  .pipe(email);

const register = z
  .object({
    email: registerEmail,
    password,
    confirmPassword,
    displayName: z.string().trim().min(1, "Укажите имя").max(50),
  })
  .refine((d) => d.password === d.confirmPassword, mismatch);

const emailOnly = z.object({ email });
const tokenOnly = z.object({ token });
const resetPassword = z
  .object({ token, password, confirmPassword })
  .refine((d) => d.password === d.confirmPassword, mismatch);

const login = z.object({ email, password: z.string().min(1).max(72) });

const refresh = z.object({ refreshToken: z.string().min(1) });

const logout = z.object({
  refreshToken: z.string().min(1).optional(),
  all: z.boolean().optional(),
});

module.exports = { password, register, emailOnly, tokenOnly, resetPassword, login, refresh, logout };
