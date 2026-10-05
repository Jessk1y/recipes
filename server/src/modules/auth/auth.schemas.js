const { z } = require("zod");

const email = z.string().trim().toLowerCase().email("Некорректный e-mail").max(254);

const register = z.object({
  email,
  // bcrypt учитывает только первые 72 байта
  password: z.string().min(8, "Пароль — не менее 8 символов").max(72, "Пароль — не более 72 символов"),
  displayName: z.string().trim().min(1, "Укажите имя").max(50),
});

const login = z.object({ email, password: z.string().min(1).max(72) });

const refresh = z.object({ refreshToken: z.string().min(1) });

const logout = z.object({
  refreshToken: z.string().min(1).optional(),
  all: z.boolean().optional(),
});

module.exports = { register, login, refresh, logout };
